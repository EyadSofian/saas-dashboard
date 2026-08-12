import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/connections/odoo/test-connection")({
  server: {
    handlers: {
      // Tests reachability, authentication and per-model read permission.
      // Every failure mode is a state in the response body, not an exception —
      // the wizard renders each one differently.
      POST: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { requirePermission, getConnection, loadConnectionSecret, recordConnectionTest } =
            await import("@/platform/workspace/repository");
          requirePermission(guard.context, "connection.test");

          const connection = await getConnection(guard.context);
          if (!connection) return errorResponse("This workspace has no Odoo connection.", 404);

          const stored = await loadConnectionSecret(guard.context, connection.id);
          if (!stored) return errorResponse("This connection has no stored credential.", 409);

          const { getSecretStore, SecretStoreError } = await import("@/platform/secrets");
          const { testOdooConnection, connectionTestFailure } =
            await import("@/platform/odoo/connection-test");

          // An unreadable credential is a failure mode of *this test* — a rotated
          // root key or a restored database, both recoverable by re-entering the
          // key. It therefore becomes a state the wizard renders, rather than a
          // 500 carrying an internal message, and follows the same recording,
          // audit and onboarding-state path as every other failure below.
          let apiKey: string | null = null;
          try {
            apiKey = await getSecretStore().get(
              {
                workspaceId: guard.context.workspaceId,
                connectionId: connection.id,
                purpose: "odoo_api_key",
              },
              stored,
            );
          } catch (error) {
            if (!(error instanceof SecretStoreError) || error.kind !== "decrypt_failed")
              throw error;
          }

          const result =
            apiKey === null
              ? connectionTestFailure("credential_unreadable")
              : await testOdooConnection({
                  baseUrl: connection.baseUrl,
                  database: connection.database,
                  login: connection.login,
                  apiKey,
                });

          await recordConnectionTest(
            guard.context,
            connection.id,
            result.state,
            result.serverVersion,
          );

          const { setOnboardingState } = await import("@/platform/workspace/repository");
          await setOnboardingState(
            guard.context,
            result.state === "success"
              ? "validating"
              : result.state === "access_denied"
                ? "permission_failed"
                : "failed",
          );

          const { writeAudit } = await import("@/platform/audit/log");
          const { AUDIT_ACTIONS } = await import("@/platform/contracts");
          await writeAudit(guard.context, {
            action: AUDIT_ACTIONS.connectionTested,
            targetType: "odoo_connection",
            targetId: connection.id,
            metadata: {
              state: result.state,
              serverVersion: result.serverVersion,
              readableModels: result.probes.filter((p) => p.canRead).length,
              permissionGaps: result.probes.filter((p) => p.gap).length,
            },
          });

          // `result` carries no secret by construction; the guard's redaction
          // pass is a second line of defence rather than the only one.
          return jsonResponse({ ok: true, result });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
