// SSR entry.
//
// The job worker starts here rather than in a separate process: one deployable,
// no extra infrastructure, and the queue is durable so a restart resumes work
// rather than losing it. When sync volume needs its own scaling, the same
// worker runs standalone against the same queue with no code change.
import { startWorker, tickSchedules } from "./platform/jobs/handlers";
import { databaseConfigured } from "./platform/db/pool";

if (databaseConfigured() && process.env.DISABLE_JOB_WORKER !== "1") {
  startWorker();

  // Scheduling is a separate, cheaper loop than job execution: it only asks
  // "who is due?" and enqueues, so it can run often without touching Odoo.
  setInterval(() => {
    void tickSchedules().catch(() => undefined);
  }, 60_000).unref();
}

export { default } from "@tanstack/react-start/server-entry";
