// Durable job runner backed by PostgreSQL.
//
// Replaces the in-process runner. The two properties that matter:
//
//   • A job survives a process restart. It lives in a table, not in a Map, so
//     a deploy or a crash mid-run leaves it claimable rather than lost.
//   • Any replica can claim it. Claiming uses SELECT ... FOR UPDATE SKIP LOCKED,
//     so N workers polling the same queue never hand the same job to two of them
//     and never block each other.
//
// A claim is a *lease*, not a lock. A worker that dies holding a lock strands
// the job until a human notices; a worker that dies holding a lease simply lets
// it expire, and the next worker resumes from the job's checkpoint.
//
// This is deliberately not Temporal. Temporal is the better answer at the scale
// where workflow versioning, signals and long timers matter — but it is a
// stateful cluster to operate, and everything this product needs today is a
// durable queue with checkpoints. The interface is unchanged, so swapping the
// implementation later is an adapter, not a rewrite.
import { withAdmin, withWorkspace } from "../db/pool";
import type { WorkspaceContext } from "../contracts";
import { safeErrorMessage } from "../audit/redact";

export interface DurableJob {
  id: string;
  workspaceId: string;
  kind: string;
  payload: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface JobHandlerContext {
  job: DurableJob;
  context: WorkspaceContext;
  signal: AbortSignal;
  checkpoint: (state: Record<string, unknown>) => Promise<void>;
  /** Extends the lease during a long step, so it is not stolen mid-flight. */
  heartbeat: () => Promise<void>;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<void>;

/** How long a claim is held before another worker may take the job. */
const LEASE_SECONDS = 120;

export interface EnqueueInput {
  workspaceId: string;
  kind: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  runAfter?: Date;
  maxAttempts?: number;
}

/**
 * Adds a job, or returns the existing one.
 *
 * Two guards, both partial unique indexes: an idempotency key deduplicates a
 * specific request, and `job_queue_one_live` stops a second job of the same
 * kind for the same workspace regardless of key. The second matters more — it
 * is what stops a schedule and a manual click from scanning one Odoo twice.
 */
export async function enqueueJob(input: EnqueueInput): Promise<{ id: string; created: boolean }> {
  return withAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO job_queue (workspace_id, kind, payload, idempotency_key, run_after, max_attempts)
       VALUES ($1,$2,$3::jsonb,$4,COALESCE($5, now()),$6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        input.workspaceId,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        input.idempotencyKey ?? null,
        input.runAfter ?? null,
        input.maxAttempts ?? 3,
      ],
    );

    if (rows[0]) return { id: rows[0].id, created: true };

    // A conflict means a live job already exists; return it rather than
    // reporting failure, because the caller's intent is already satisfied.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM job_queue
        WHERE workspace_id = $1 AND kind = $2 AND status IN ('queued','running')
        ORDER BY created_at DESC LIMIT 1`,
      [input.workspaceId, input.kind],
    );
    return { id: existing.rows[0]?.id ?? "", created: false };
  });
}

/**
 * Claims one runnable job for this worker.
 *
 * SKIP LOCKED is what makes this safe with many workers: a row already being
 * claimed by another transaction is skipped instead of blocking, so throughput
 * scales with worker count instead of serialising on the queue head.
 *
 * The attempt budget is enforced here and not only in `failJob`. A handler that
 * throws goes through `failJob`, which counts attempts and eventually gives up.
 * A handler whose *process* dies — an OOM, a deploy, a host restart — never
 * reaches that code at all: the row simply stays `running` until its lease
 * lapses. Without the budget in this query such a job is reclaimed forever,
 * each reclaim incrementing `attempts` against a limit nothing consults, and a
 * customer watches "Refreshing" that will never end.
 */
export async function claimJob(workerId: string, kinds: string[]): Promise<DurableJob | null> {
  return withAdmin(async (client) => {
    const { rows } = await client.query(
      `UPDATE job_queue SET
         status = 'running',
         leased_by = $1,
         leased_until = now() + make_interval(secs => $2),
         attempts = attempts + 1,
         started_at = COALESCE(started_at, now())
       WHERE id = (
         SELECT id FROM job_queue
          WHERE kind = ANY($3)
            AND run_after <= now()
            AND attempts < max_attempts
            AND (
              status = 'queued'
              -- A running job whose lease expired: its worker died, so it is
              -- claimable again and resumes from its checkpoint.
              OR (status = 'running' AND (leased_until IS NULL OR leased_until < now()))
            )
          ORDER BY run_after, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING id, workspace_id, kind, payload, checkpoint, attempts, max_attempts`,
      [workerId, LEASE_SECONDS, kinds],
    );

    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      kind: String(row.kind),
      payload: (row.payload as Record<string, unknown>) ?? {},
      checkpoint: (row.checkpoint as Record<string, unknown>) ?? {},
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
    };
  });
}

export async function saveCheckpoint(
  context: WorkspaceContext,
  jobId: string,
  state: Record<string, unknown>,
): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query(
      "UPDATE job_queue SET checkpoint = $1::jsonb WHERE id = $2 AND workspace_id = $3",
      [JSON.stringify(state), jobId, context.workspaceId],
    );
  });
}

export async function heartbeatJob(jobId: string, workerId: string): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(
      `UPDATE job_queue
          SET leased_until = now() + make_interval(secs => $1)
        WHERE id = $2 AND leased_by = $3 AND status = 'running'`,
      [LEASE_SECONDS, jobId, workerId],
    );
  });
}

export async function completeJob(jobId: string): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(
      "UPDATE job_queue SET status='succeeded', finished_at=now(), leased_by=NULL, leased_until=NULL WHERE id=$1",
      [jobId],
    );
  });
}

/**
 * Records a failure, retrying with backoff until the attempt budget runs out.
 *
 * The checkpoint is deliberately preserved on a retry: work already done is not
 * repeated, which is the whole point of checkpointing a long extract.
 */
export async function failJob(jobId: string, error: unknown): Promise<"retrying" | "failed"> {
  return withAdmin(async (client) => {
    const { rows } = await client.query<{ attempts: number; max_attempts: number }>(
      "SELECT attempts, max_attempts FROM job_queue WHERE id = $1",
      [jobId],
    );
    const job = rows[0];
    const exhausted = !job || job.attempts >= job.max_attempts;

    if (exhausted) {
      await client.query(
        "UPDATE job_queue SET status='failed', error=$1, finished_at=now(), leased_by=NULL, leased_until=NULL WHERE id=$2",
        [safeErrorMessage(error), jobId],
      );
      return "failed";
    }

    // Exponential backoff, so a transient Odoo outage is not hammered.
    const delaySeconds = Math.min(300, 15 * 2 ** job.attempts);
    await client.query(
      `UPDATE job_queue
          SET status='queued', error=$1, leased_by=NULL, leased_until=NULL,
              run_after = now() + make_interval(secs => $2)
        WHERE id=$3`,
      [safeErrorMessage(error), delaySeconds, jobId],
    );
    return "retrying";
  });
}

/**
 * Resolves the workspace context a job runs under.
 *
 * A job carries no identity of its own: it acts as the system, scoped to one
 * workspace. Every role is granted so the handler is not blocked by a
 * permission check meant for humans, but the workspace boundary is unchanged —
 * RLS still confines it to that one workspace.
 */
export async function jobContext(workspaceId: string): Promise<WorkspaceContext> {
  return withAdmin(async (client) => {
    const { rows } = await client.query<{ organization_id: string }>(
      "SELECT organization_id FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    if (!rows[0]) throw new Error(`Workspace ${workspaceId} no longer exists.`);
    return {
      workspaceId,
      organizationId: rows[0].organization_id,
      // A system actor, not a person: audit records show actorUserId null.
      userId: "00000000-0000-4000-8000-000000000000",
      roles: ["workspace_owner", "data_admin", "financial_approver"],
    };
  });
}

export interface WorkerOptions {
  workerId?: string;
  kinds: string[];
  handlers: Record<string, JobHandler>;
  pollIntervalMs?: number;
}

/**
 * A polling worker loop.
 *
 * Deliberately a plain loop rather than LISTEN/NOTIFY: polling a few times a
 * minute costs nothing at this scale, survives a dropped connection without
 * extra machinery, and cannot miss a notification delivered while the worker
 * was restarting.
 */
export class JobWorker {
  private readonly workerId: string;
  private readonly controller = new AbortController();
  private running = false;

  constructor(private readonly options: WorkerOptions) {
    this.workerId = options.workerId ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
  }

  /** Runs one job if one is available. Returns whether it did any work. */
  async tick(): Promise<boolean> {
    const job = await claimJob(this.workerId, this.options.kinds);
    if (!job) return false;

    const handler = this.options.handlers[job.kind];
    if (!handler) {
      await failJob(job.id, new Error(`No handler registered for job kind "${job.kind}".`));
      return true;
    }

    try {
      const context = await jobContext(job.workspaceId);
      await handler({
        job,
        context,
        signal: this.controller.signal,
        checkpoint: (state) => saveCheckpoint(context, job.id, state),
        heartbeat: () => heartbeatJob(job.id, this.workerId),
      });
      await completeJob(job.id);
    } catch (error) {
      // Never let a background failure disappear. Only the already-sanitized
      // first line is logged; decrypted credentials are never included.
      console.error(`[job:${job.kind}:${job.id}] ${safeErrorMessage(error)}`);
      await failJob(job.id, error);
    }
    return true;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const interval = this.options.pollIntervalMs ?? 5_000;

    while (this.running && !this.controller.signal.aborted) {
      let worked = false;
      try {
        // Before claiming anything, close out whatever died without being able
        // to report it. Cheap, and it runs on every idle poll, so a job
        // orphaned by a deploy reaches a terminal state within seconds rather
        // than waiting for someone to notice.
        const reaped = await reapAbandonedJobs();
        if (reaped > 0) {
          console.error(`[job-queue] marked ${reaped} abandoned job(s) as failed`);
        }
        worked = await this.tick();
      } catch (error) {
        // A queue-level failure (database blip) must not kill the loop; the
        // next poll retries. It must still be visible in Railway logs.
        console.error(`[job-queue] ${safeErrorMessage(error)}`);
      }
      // Back off only when idle, so a backlog drains without waiting.
      if (!worked) await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  stop(): void {
    this.running = false;
    this.controller.abort();
  }
}

/** Jobs whose lease expired — surfaced so a stuck queue is visible, not silent. */
export async function stalledJobs(): Promise<number> {
  return withAdmin(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM job_queue
        WHERE status = 'running' AND (leased_until IS NULL OR leased_until < now())`,
    );
    return Number(rows[0].count);
  });
}

/**
 * Closes out jobs that died mid-run and have no attempts left.
 *
 * `claimJob` refuses to reclaim these, which is what stops the endless retry —
 * but refusing to reclaim is not the same as finishing. Without this they stay
 * `running` with a lapsed lease forever, and every reader, the dashboard
 * included, keeps reporting a refresh that nothing is working on. A terminal
 * state is what lets the customer be told the truth and try again.
 */
export async function reapAbandonedJobs(): Promise<number> {
  return withAdmin(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE job_queue
          SET status = 'failed',
              error = COALESCE(error, 'The worker running this job stopped before it finished, and the retry budget is spent.'),
              finished_at = now(),
              leased_by = NULL,
              leased_until = NULL
        WHERE status = 'running'
          -- A null lease counts as lapsed. Comparing null to now() yields null
          -- rather than false, so a running row that lost its lease entirely
          -- would be skipped by every comparison and sit there forever, which
          -- is the exact shape of the bug this function exists to end.
          AND (leased_until IS NULL OR leased_until < now())
          AND attempts >= max_attempts`,
    );
    return rowCount ?? 0;
  });
}
