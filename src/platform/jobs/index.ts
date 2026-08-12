// Job surface.
//
// Execution lives in `durable.ts` (a PostgreSQL-backed queue). This module
// exposes the small context shape that long-running work depends on, so
// discovery and sync do not import the queue implementation directly and stay
// testable without a database.
export type { DurableJob, JobHandler, JobHandlerContext } from "./durable";
export { enqueueJob, JobWorker, stalledJobs } from "./durable";

/** What a long-running unit of work is given, whatever runs it. */
export interface JobContext {
  signal: AbortSignal;
  /** Persists a resume point. A crash continues from here. */
  checkpoint: (state: Record<string, unknown>) => Promise<void>;
  /** The checkpoint left by a previous interrupted attempt. */
  resumeFrom: Record<string, unknown>;
}
