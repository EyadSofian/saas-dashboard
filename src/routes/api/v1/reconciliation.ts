import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/reconciliation")({
  server: {
    handlers: {
      // The most recent reconciliation: every check with its source value, our
      // value, the difference and the tolerance it was judged against.
      GET: async ({ request }) => {
        const { requireWorkspace, jsonResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { latestReconciliation } = await import("@/platform/reconciliation/run");
          return jsonResponse({ ok: true, run: await latestReconciliation(guard.context) });
        } catch (error) {
          return handleRouteError(error);
        }
      },

      // Accepts non-critical differences so a generation can publish.
      //
      // Only warnings can be accepted. A critical failure has no acceptance
      // path — there is no note that makes a mismatched revenue total safe.
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

        const runId = typeof payload.runId === "string" ? payload.runId : "";
        const note = typeof payload.note === "string" ? payload.note.trim() : "";
        if (!runId) return errorResponse("runId is required.", 400);
        // A blank note is not an acceptance; the point is that someone stated
        // they know what they are publishing past.
        if (note.length < 3) return errorResponse("A reason is required to accept warnings.", 400);

        try {
          const { requirePermission } = await import("@/platform/workspace/repository");
          requirePermission(guard.context, "policy.approve");

          const { acceptWarnings } = await import("@/platform/reconciliation/run");
          const accepted = await acceptWarnings(guard.context, runId, note);
          if (!accepted) {
            return errorResponse("Critical differences cannot be accepted.", 409, {
              reason: "critical_failure_present",
            });
          }

          const { writeAudit } = await import("@/platform/audit/log");
          await writeAudit(guard.context, {
            action: "reconciliation.warnings_accepted",
            targetType: "reconciliation_run",
            targetId: runId,
            metadata: { note },
          });

          return jsonResponse({ ok: true });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
