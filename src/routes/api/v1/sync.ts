import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/sync")({
  server: {
    handlers: {
      // Sync state: the active generation, recent runs, and health.
      GET: async ({ request }) => {
        const { requireWorkspace, jsonResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { activeGeneration } = await import("@/platform/sync/run");
          const { listHealth } = await import("@/platform/health");
          const { withWorkspace } = await import("@/platform/db/pool");

          const [generationId, health] = await Promise.all([
            activeGeneration(guard.context),
            listHealth(guard.context),
          ]);

          const { runs, jobs, generation } = await withWorkspace(guard.context, async (client) => {
            const runsResult = await client.query(
              `SELECT id, status, error, stats, started_at, finished_at
                 FROM sync_runs WHERE workspace_id = $1 AND kind = 'sync'
                ORDER BY started_at DESC LIMIT 5`,
              [guard.context.workspaceId],
            );
            const jobsResult = await client.query(
              // `stalled` is the difference between "a refresh is running" and
              // "a refresh is claimed by a worker that is no longer there". Both
              // read as status='running', and reporting the second as progress
              // is what left a customer watching a refresh for eleven hours.
              `SELECT id, status, error, attempts, max_attempts, created_at, started_at, finished_at,
                      (status = 'running' AND (leased_until IS NULL OR leased_until < now())) AS stalled
                 FROM job_queue
                WHERE workspace_id = $1 AND kind = 'sync'
                ORDER BY created_at DESC LIMIT 5`,
              [guard.context.workspaceId],
            );
            const generationResult = generationId
              ? await client.query(
                  `SELECT id, row_counts, published_at FROM data_generations
                    WHERE workspace_id = $1 AND id = $2`,
                  [guard.context.workspaceId, generationId],
                )
              : { rows: [] };
            return {
              runs: runsResult.rows,
              jobs: jobsResult.rows,
              generation: generationResult.rows[0] ?? null,
            };
          });

          return jsonResponse({
            ok: true,
            // Present even when the newest run failed: the pointer only moves
            // on success, so this is always the last good data.
            generation,
            latestRun: runs[0] ?? null,
            recentRuns: runs,
            latestJob: jobs[0] ?? null,
            recentJobs: jobs,
            health: health.find((h) => h.domain === "sync") ?? null,
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },

      POST: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const { FLAGS } = await import("@/platform/flags");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;
        if (!FLAGS.sync()) return errorResponse("Sync is not enabled.", 404);

        try {
          const { startSync } = await import("@/platform/sync/run");
          const { jobId } = await startSync(guard.context);
          // 202: accepted, not finished. The work continues in the durable
          // queue and survives this request, this process and the next deploy.
          return jsonResponse({ ok: true, jobId, state: "queued" }, 202);
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
