import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/connections/odoo")({
  server: {
    handlers: {
      // Connection metadata only. `hasSecret` is the sole thing ever said about
      // the credential — the key itself never leaves the server.
      GET: async ({ request }) => {
        const { requireWorkspace, jsonResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { getConnection } = await import("@/platform/workspace/repository");
          return jsonResponse({ ok: true, connection: await getConnection(guard.context) });
        } catch (error) {
          return handleRouteError(error);
        }
      },

      // Stores or replaces the workspace's Odoo connection. The API key is
      // encrypted before it reaches the database and is never echoed back.
      POST: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return errorResponse("Invalid JSON body.", 400);
        }

        const { odooConnectionInputSchema } = await import("@/platform/contracts");
        const parsed = odooConnectionInputSchema.safeParse(payload);
        if (!parsed.success) {
          return errorResponse("Invalid connection details.", 400, {
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          });
        }

        // Validate the URL before anything is stored, so an SSRF target never
        // reaches the database at all.
        const { assertSafeOdooUrl, UnsafeUrlError } = await import("@/platform/odoo/url-guard");
        let origin: string;
        try {
          origin = (await assertSafeOdooUrl(parsed.data.baseUrl)).origin;
        } catch (error) {
          if (error instanceof UnsafeUrlError) {
            return errorResponse("This Odoo URL cannot be used.", 400, { reason: error.reason });
          }
          return handleRouteError(error);
        }

        try {
          const { withSecretRedacted } = await import("@/platform/audit/redact");
          // Everything from here on runs with the API key registered for
          // redaction, so an audit record, a log line or an error raised inside
          // this handler cannot carry it — whatever field name it lands in.
          return await withSecretRedacted(parsed.data.apiKey, async () => {
            const { getSecretStore, SecretStoreError } = await import("@/platform/secrets");
            const { getConnection, upsertConnection, requirePermission, setOnboardingState } =
              await import("@/platform/workspace/repository");
            const { writeAudit } = await import("@/platform/audit/log");
            const { AUDIT_ACTIONS } = await import("@/platform/contracts");

            requirePermission(guard.context, "connection.write");

            // A connection id is needed for the AAD binding, so an existing
            // connection is reused and a new one gets its id here.
            const existing = await getConnection(guard.context);
            const connectionId = existing?.id ?? crypto.randomUUID();

            let secret;
            try {
              secret = await getSecretStore().put(
                {
                  workspaceId: guard.context.workspaceId,
                  connectionId,
                  purpose: "odoo_api_key",
                },
                parsed.data.apiKey,
              );
            } catch (error) {
              if (error instanceof SecretStoreError && error.kind === "production_guard") {
                // Fail closed: refuse to store rather than store unsafely.
                return errorResponse(
                  "Credential storage is not available in this environment.",
                  503,
                  {
                    reason: "secret_store_not_production_grade",
                  },
                );
              }
              throw error;
            }

            const connection = await upsertConnection(guard.context, {
              connectionId,
              baseUrl: origin,
              database: parsed.data.database,
              login: parsed.data.login,
              secret,
            });

            await writeAudit(guard.context, {
              action: existing ? AUDIT_ACTIONS.connectionUpdated : AUDIT_ACTIONS.connectionCreated,
              targetType: "odoo_connection",
              targetId: connection.id,
              // Record what changed, never the value that changed.
              metadata: {
                baseUrl: origin,
                database: parsed.data.database,
                login: parsed.data.login,
              },
            });
            await setOnboardingState(guard.context, "connection_pending");

            return jsonResponse({ ok: true, connection }, existing ? 200 : 201);
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
