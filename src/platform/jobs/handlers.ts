// Job handlers and the worker bootstrap.
//
// The API routes enqueue; this is what actually runs. Keeping the two apart is
// what lets a request return in milliseconds while a ten-minute scan continues
// independently — and lets that scan survive the request, the process, and the
// deploy that happens mid-run.
import { withAdmin } from "../db/pool";
import { JobWorker, enqueueJob, type JobHandler } from "./durable";
import { dueSchedules, markScheduled } from "../sync/incremental";

export const JOB_KINDS = ["discovery", "sync"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * Handlers are resolved lazily.
 *
 * `discovery/run` and `sync/run` pull in the Odoo connector and the secret
 * store; importing them at module load would make the web process pay for the
 * worker's dependencies on every cold start.
 */
export const HANDLERS: Record<JobKind, JobHandler> = {
  discovery: async ({ context, signal, checkpoint, heartbeat }) => {
    const { runDiscovery } = await import("../discovery/run");
    await runDiscovery(context, { signal, checkpoint, heartbeat });
  },
  sync: async ({ context, signal, checkpoint, heartbeat }) => {
    const { runSync } = await import("../sync/run");
    await runSync(context, { signal, checkpoint, heartbeat });
  },
};

let worker: JobWorker | null = null;

/**
 * Starts the in-process worker.
 *
 * Running the worker inside the web process is the right trade at this size:
 * one deployable, no extra infrastructure, and the durable queue means a
 * restart costs a resumed job rather than a lost one. When sync volume needs
 * its own scaling, the same worker runs as a separate process against the same
 * queue with no code change.
 */
export function startWorker(): JobWorker {
  if (worker) return worker;
  worker = new JobWorker({
    kinds: [...JOB_KINDS],
    handlers: HANDLERS as Record<string, JobHandler>,
    pollIntervalMs: 5_000,
  });
  void worker.start();
  return worker;
}

/**
 * Starts the worker if it is not already running, and says so once.
 *
 * Idempotent and cheap, so it is safe to call from a request path. That is the
 * point: the SSR entry's module side effect is not a guarantee — whether it
 * runs depends on how the bundle is built and invoked — and a queue that never
 * starts is indistinguishable from an idle one. Calling this from the API guard
 * means the first authenticated request brings the worker up wherever the
 * entry did not.
 *
 * The log line is deliberate. A background worker that announces nothing can be
 * absent for hours without anyone being able to tell.
 */
export function ensureWorker(reason: string): JobWorker {
  const existing = worker;
  const active = startWorker();
  if (!existing) console.log(`[worker] started (${reason})`);
  return active;
}

/**
 * Best-effort nudge used after an interactive enqueue.
 *
 * The normal five-second worker loop remains the source of truth. This simply
 * removes the awkward gap after a user clicks a button and also gives serverless
 * style runtimes a chance to execute the accepted job while the request process
 * is definitely awake. `SKIP LOCKED` keeps this safe if the background loop wins
 * the race.
 */
export function nudgeWorker(): void {
  const active = startWorker();
  void active.tick().catch(() => undefined);
}

export function stopWorker(): void {
  worker?.stop();
  worker = null;
}

/**
 * Enqueues whatever is due.
 *
 * Runs as admin because it spans workspaces — it is the one query that has to
 * ask "which customers are due?" before any workspace context exists. The jobs
 * it creates are each scoped to one workspace, and `job_queue_one_live` means a
 * schedule firing while a manual refresh is already running is a no-op rather
 * than a duplicate scan.
 */
export async function tickSchedules(): Promise<number> {
  return withAdmin(async (client) => {
    const due = await dueSchedules(client);
    let enqueued = 0;

    for (const schedule of due) {
      const result = await enqueueJob({
        workspaceId: schedule.workspaceId,
        kind: schedule.kind,
        payload: { trigger: "schedule" },
      });
      if (result.created) enqueued += 1;
      // Marked regardless: a skipped run because one was already live is still
      // a run for scheduling purposes, or the schedule would fire in a tight
      // loop for as long as the manual job takes.
      await markScheduled(client, schedule.workspaceId, schedule.kind, schedule.intervalMinutes);
    }
    return enqueued;
  });
}

/** Turns scheduled sync on for a workspace. */
export async function setSchedule(
  workspaceId: string,
  kind: JobKind,
  intervalMinutes: number,
  enabled = true,
): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(
      `INSERT INTO workspace_schedules (workspace_id, kind, interval_minutes, enabled, next_run_at)
       VALUES ($1,$2,$3,$4, now() + make_interval(mins => $3))
       ON CONFLICT (workspace_id, kind) DO UPDATE SET
         interval_minutes = EXCLUDED.interval_minutes,
         enabled          = EXCLUDED.enabled`,
      [workspaceId, kind, intervalMinutes, enabled],
    );
  });
}
