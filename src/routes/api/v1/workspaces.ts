import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/workspaces")({
  server: {
    handlers: {
      // Creates an organization, its first workspace, and an owner membership.
      //
      // Runs as a control-plane operation: the workspace does not exist yet, so
      // there is no context to scope it to. Ids are generated server-side and
      // never accepted from the client.
      POST: async ({ request }) => {
        const noStore = { headers: { "cache-control": "no-store" } };
        const json = (body: unknown, status = 200) => Response.json(body, { status, ...noStore });

        const { getSessionUser } = await import("@/platform/auth");
        const user = await getSessionUser(request);
        if (!user) return json({ ok: false, error: "Authentication required." }, 401);

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body." }, 400);
        }

        const { createWorkspaceInputSchema } = await import("@/platform/contracts");
        const parsed = createWorkspaceInputSchema.safeParse(payload);
        if (!parsed.success) {
          return json(
            {
              ok: false,
              error: "Invalid workspace details.",
              issues: parsed.error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
              })),
            },
            400,
          );
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
              metadata: { name: parsed.data.workspaceName, industryPack: parsed.data.industryPack },
            });
          }
          return json({ ok: true, ...created }, 201);
        } catch (error) {
          const { safeErrorMessage } = await import("@/platform/audit/redact");
          return json({ ok: false, error: safeErrorMessage(error, 200) }, 500);
        }
      },
    },
  },
});
