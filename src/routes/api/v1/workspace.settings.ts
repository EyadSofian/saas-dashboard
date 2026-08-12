import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/workspace/settings")({
  server: {
    handlers: {
      // Plan, current usage against its limits, and any pending deletion.
      GET: async ({ request }) => {
        const { requireWorkspace, jsonResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { planFor, checkLimit, usageSince } =
            await import("@/platform/billing/entitlements");
          const { pendingDeletion } = await import("@/platform/workspace/lifecycle");
          const monthStart = new Date();
          monthStart.setUTCDate(1);
          monthStart.setUTCHours(0, 0, 0, 0);

          const [plan, connections, members, dashboards, rows, usage, deletion] = await Promise.all(
            [
              planFor(guard.context),
              checkLimit(guard.context, "connections"),
              checkLimit(guard.context, "members"),
              checkLimit(guard.context, "dashboards"),
              checkLimit(guard.context, "syncedRows"),
              usageSince(guard.context, monthStart),
              pendingDeletion(guard.context),
            ],
          );

          return jsonResponse({
            ok: true,
            plan,
            limits: { connections, members, dashboards, syncedRows: rows },
            usage,
            deletion,
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },

      // Export, or schedule/cancel deletion.
      POST: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        let payload: Record<string, unknown>;
        try {
          payload = await request.json();
        } catch {
          return errorResponse("Invalid JSON body.", 400);
        }

        const action = typeof payload.action === "string" ? payload.action : "";

        try {
          const lifecycle = await import("@/platform/workspace/lifecycle");
          const { writeAudit } = await import("@/platform/audit/log");
          const { recordUsage } = await import("@/platform/billing/entitlements");

          if (action === "export") {
            const dump = await lifecycle.exportWorkspace(guard.context);
            await recordUsage(guard.context, "export", 1);
            await writeAudit(guard.context, {
              action: "workspace.exported",
              targetType: "workspace",
              targetId: guard.context.workspaceId,
              metadata: {},
            });
            return jsonResponse({ ok: true, export: dump });
          }

          if (action === "request_deletion") {
            const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
            // A reason is required: an irreversible request should take a
            // moment's thought, and support needs to know what went wrong.
            if (reason.length < 3) return errorResponse("A reason is required.", 400);

            const result = await lifecycle.requestDeletion(guard.context, reason);
            await writeAudit(guard.context, {
              action: "workspace.deletion_requested",
              targetType: "workspace",
              targetId: guard.context.workspaceId,
              metadata: { reason, executeAfter: result.executeAfter },
            });
            return jsonResponse({ ok: true, deletion: result });
          }

          if (action === "cancel_deletion") {
            const cancelled = await lifecycle.cancelDeletion(guard.context);
            if (cancelled) {
              await writeAudit(guard.context, {
                action: "workspace.deletion_cancelled",
                targetType: "workspace",
                targetId: guard.context.workspaceId,
                metadata: {},
              });
            }
            return jsonResponse({ ok: cancelled });
          }

          return errorResponse("Unknown action.", 400);
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
