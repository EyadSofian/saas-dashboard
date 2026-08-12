import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/discovery")({
  server: {
    handlers: {
      // Current state: the latest ready snapshot — which survives a failed run —
      // plus the most recent run's outcome, reported separately.
      GET: async ({ request }) => {
        const { requireWorkspace, jsonResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { latestSnapshot } = await import("@/platform/workspace/repository");
          const { listHealth } = await import("@/platform/health");
          const { withWorkspace } = await import("@/platform/db/pool");

          const [snapshot, health] = await Promise.all([
            latestSnapshot(guard.context),
            listHealth(guard.context),
          ]);

          const runs = await withWorkspace(guard.context, async (client) => {
            const { rows } = await client.query(
              `SELECT id, status, error, started_at, finished_at
                 FROM sync_runs
                WHERE workspace_id = $1 AND kind = 'discovery'
                ORDER BY started_at DESC LIMIT 5`,
              [guard.context.workspaceId],
            );
            return rows;
          });

          return jsonResponse({
            ok: true,
            // Last-good: present even when the newest run failed.
            snapshot,
            latestRun: runs[0] ?? null,
            recentRuns: runs,
            health: health.find((h) => h.domain === "discovery") ?? null,
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },

      // Starts a discovery run and returns immediately: a full scan targets
      // under 10 minutes, far too long to hold a request open.
      POST: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const { FLAGS } = await import("@/platform/flags");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;
        if (!FLAGS.odooDiscovery()) return errorResponse("Discovery is not enabled.", 404);

        try {
          const { startDiscovery } = await import("@/platform/discovery/run");
          const handle = await startDiscovery(guard.context);
          // The job records its own failures; this only stops an unhandled
          // rejection from taking the process down.
          handle.completion.catch(() => undefined);
          return jsonResponse({ ok: true, jobId: handle.jobId, state: "running" }, 202);
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
