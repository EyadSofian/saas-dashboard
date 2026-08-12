import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/workspaces")({
  server: {
    handlers: {
      // Lists the workspaces the signed-in user may enter. This is the one
      // legitimate pre-workspace query, so it runs with user context only.
      GET: async ({ request }) => {
        const { FLAGS } = await import("@/platform/flags");
        const { errorResponse, jsonResponse } = await import("@/platform/api/guard");
        if (!FLAGS.workspaces()) return errorResponse("Not found.", 404);

        const { databaseConfigured } = await import("@/platform/db/pool");
        if (!databaseConfigured()) {
          return errorResponse("The platform database is not configured.", 503);
        }

        const { getSessionUser } = await import("@/platform/auth");
        const user = await getSessionUser(request);
        if (!user) return errorResponse("Authentication required.", 401);

        const { listWorkspacesForUser } = await import("@/platform/workspace/repository");
        try {
          return jsonResponse({ ok: true, workspaces: await listWorkspacesForUser(user.id) });
        } catch (error) {
          const { handleRouteError } = await import("@/platform/api/guard");
          return handleRouteError(error);
        }
      },

      // Creates an organization, workspace and owner membership.
      POST: async ({ request }) => {
        const { FLAGS } = await import("@/platform/flags");
        const { errorResponse, jsonResponse, handleRouteError } =
          await import("@/platform/api/guard");
        if (!FLAGS.workspaces()) return errorResponse("Not found.", 404);

        const { getSessionUser } = await import("@/platform/auth");
        const user = await getSessionUser(request);
        if (!user) return errorResponse("Authentication required.", 401);

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return errorResponse("Invalid JSON body.", 400);
        }

        const { createWorkspaceInputSchema } = await import("@/platform/contracts");
        const parsed = createWorkspaceInputSchema.safeParse(payload);
        if (!parsed.success) {
          return errorResponse("Invalid workspace details.", 400, {
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          });
        }

        try {
          const { provisionWorkspace, resolveWorkspaceContext } =
            await import("@/platform/workspace/repository");
          const { writeAudit } = await import("@/platform/audit/log");
          const { AUDIT_ACTIONS } = await import("@/platform/contracts");

          const created = await provisionWorkspace({ userId: user.id, ...parsed.data });
          const context = await resolveWorkspaceContext(user.id, created.workspaceId);
          if (context) {
            await writeAudit(context, {
              action: AUDIT_ACTIONS.workspaceCreated,
              targetType: "workspace",
              targetId: created.workspaceId,
              metadata: { name: parsed.data.workspaceName },
            });
          }
          return jsonResponse({ ok: true, ...created }, 201);
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
