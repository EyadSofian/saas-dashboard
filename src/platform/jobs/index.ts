// JobRunner — ADR-0003.
//
// Temporal is the Phase 3 target. Discovery is written against this interface
// and never against the concrete class, so the swap is an adapter rather than a
// rewrite. No Temporal dependency, worker or scaffold exists in this milestone.

export interface JobSpec<TResult> {
  workspaceId: string;
  kind: string;
  /** Deduplicates enqueues. A repeated key returns the existing handle. */
  idempotencyKey?: string;
  run: (ctx: JobContext) => Promise<TResult>;
}

export interface JobContext {
  workspaceId: string;
  jobId: string;
  signal: AbortSignal;
  /** Persists a resume point. A crash resumes here rather than restarting. */
  checkpoint: (state: Record<string, unknown>) => Promise<void>;
  /** The checkpoint from a previous interrupted attempt, if any. */
  resumeFrom: Record<string, unknown>;
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";

export interface JobStatus {
  jobId: string;
  workspaceId: string;
  kind: string;
  state: JobState;
  error?: string;
  checkpoint: Record<string, unknown>;
}

export interface JobHandle {
  jobId: string;
  /** Resolves when the job settles. Rejects only on a job error, never on cancel. */
  completion: Promise<void>;
}

export interface JobRunner {
  enqueue<T>(job: JobSpec<T>): Promise<JobHandle>;
  status(jobId: string): Promise<JobStatus | null>;
  cancel(jobId: string): Promise<void>;
}

export interface CheckpointStore {
  load(workspaceId: string, kind: string): Promise<Record<string, unknown>>;
  save(jobId: string, state: Record<string, unknown>): Promise<void>;
}

const memoryCheckpoints: CheckpointStore = {
  async load() {
    return {};
  },
  async save() {},
};

/**
 * In-process runner with per-workspace serialization.
 *
 * Known limits, spelled out in ADR-0003: jobs do not survive a process restart
 * in flight (the run is marked `interrupted` and resumes from its checkpoint on
 * the next trigger), and serialization is per-instance.
 */
export class InProcessJobRunner implements JobRunner {
  private readonly jobs = new Map<string, JobStatus>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly byIdempotencyKey = new Map<string, JobHandle>();
  /** One live job per workspace+kind; later enqueues chain behind it. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly checkpoints: CheckpointStore = memoryCheckpoints) {}

  async enqueue<T>(job: JobSpec<T>): Promise<JobHandle> {
    const dedupeKey = job.idempotencyKey
      ? `${job.workspaceId}:${job.kind}:${job.idempotencyKey}`
      : null;
    if (dedupeKey) {
      const existing = this.byIdempotencyKey.get(dedupeKey);
      if (existing) return existing;
    }

    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    this.jobs.set(jobId, {
      jobId,
      workspaceId: job.workspaceId,
      kind: job.kind,
      state: "queued",
      checkpoint: {},
    });

    const chainKey = `${job.workspaceId}:${job.kind}`;
    const previous = this.chains.get(chainKey) ?? Promise.resolve();

    const completion = previous
      .catch(() => undefined) // A prior failure must not cancel the next run.
      .then(async () => {
        const status = this.jobs.get(jobId)!;
        if (controller.signal.aborted) {
          status.state = "cancelled";
          return;
        }
        status.state = "running";
        const resumeFrom = await this.checkpoints.load(job.workspaceId, job.kind);
        status.checkpoint = resumeFrom;
        try {
          await job.run({
            workspaceId: job.workspaceId,
            jobId,
            signal: controller.signal,
            resumeFrom,
            checkpoint: async (state) => {
              status.checkpoint = state;
              await this.checkpoints.save(jobId, state);
            },
          });
          status.state = "succeeded";
        } catch (error) {
          if (controller.signal.aborted) {
            status.state = "cancelled";
            return;
          }
          status.state = "failed";
          status.error = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          this.controllers.delete(jobId);
        }
      });

    this.chains.set(
      chainKey,
      completion.catch(() => undefined),
    );

    const handle: JobHandle = { jobId, completion };
    if (dedupeKey) this.byIdempotencyKey.set(dedupeKey, handle);
    return handle;
  }

  async status(jobId: string): Promise<JobStatus | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async cancel(jobId: string): Promise<void> {
    this.controllers.get(jobId)?.abort();
    const status = this.jobs.get(jobId);
    if (status && (status.state === "queued" || status.state === "running")) {
      status.state = "cancelled";
    }
  }
}

let runner: JobRunner | null = null;

export function getJobRunner(): JobRunner {
  if (!runner) runner = new InProcessJobRunner();
  return runner;
}

/** Test seam, and the Phase 3 swap point for the Temporal-backed runner. */
export function setJobRunner(next: JobRunner | null): void {
  runner = next;
}
