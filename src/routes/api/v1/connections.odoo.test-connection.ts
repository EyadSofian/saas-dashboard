import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/connections/odoo/test-connection")({
  server: {
    handlers: {
      // Tests reachability, authentication and per-model read permission.
      // Every failure mode is a state in the body rather than an exception,
      // because the wizard renders each one differently.
      POST: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const {
            requirePermission,
            getConnection,
            loadConnectionSecret,
            recordConnectionTest,
            setOnboardingState,
          } = await import("@/platform/workspace/repository");
          requirePermission(guard.context, "connection.test");

          const connection = await getConnection(guard.context);
          if (!connection) return errorResponse("This workspace has no Odoo connection.", 404);

          const stored = await loadConnectionSecret(guard.context, connection.id);
          if (!stored) return errorResponse("This connection has no stored credential.", 409);

          const { getSecretStore, SecretStoreError } = await import("@/platform/secrets");
          let apiKey: string;
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
            if (error instanceof SecretStoreError && error.kind === "decrypt_failed") {
              return errorResponse("The saved Odoo credential must be entered again.", 409, {
                reason: "credential_requires_reentry",
              });
            }
            throw error;
          }

          const { testOdooConnection } = await import("@/platform/odoo/connection-test");
          const result = await testOdooConnection({
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
          await setOnboardingState(
            guard.context,
            result.state === "success"
              ? "validating"
              : result.state === "access_denied"
                ? "permission_failed"
                : "failed",
          );

          // A successful connection test is the user's approval to continue
          // the onboarding journey. Queue discovery immediately instead of
          // making them hunt for a second button below a long permissions
          // table. The durable queue keeps this safe and idempotent.
          let discoveryJobId: string | null = null;
          if (result.state === "success") {
            const { startDiscovery } = await import("@/platform/discovery/run");
            discoveryJobId = (await startDiscovery(guard.context)).jobId;
          }

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

          return jsonResponse({ ok: true, result, discoveryJobId });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
