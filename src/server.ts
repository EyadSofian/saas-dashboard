// SSR entry.
//
// The job worker starts here rather than in a separate process: one deployable,
// no extra infrastructure, and the queue is durable so a restart resumes work
// rather than losing it. When sync volume needs its own scaling, the same
// worker runs standalone against the same queue with no code change.
//
// Starting it from a module side effect is convenient and unreliable: whether
// this module is evaluated at all depends on how the SSR bundle is built and
// invoked, and when it is not, nothing anywhere says so. A queue that silently
// never runs looks exactly like a queue with nothing to do, which is how a
// stuck refresh went unexplained for eleven hours. So the attempt is announced
// either way, and `ensureWorker` in the API guard is the backstop that does not
// depend on this file being evaluated at all.
import { ensureWorker, tickSchedules } from "./platform/jobs/handlers";
import { databaseConfigured } from "./platform/db/pool";

if (!databaseConfigured()) {
  console.log("[worker] not started: no database is configured");
} else if (process.env.DISABLE_JOB_WORKER === "1") {
  console.log("[worker] not started: DISABLE_JOB_WORKER=1");
} else {
  ensureWorker("ssr-entry");

  // Scheduling is a separate, cheaper loop than job execution: it only asks
  // "who is due?" and enqueues, so it can run often without touching Odoo.
  setInterval(() => {
    void tickSchedules().catch(() => undefined);
  }, 60_000).unref();
}

export { default } from "@tanstack/react-start/server-entry";
