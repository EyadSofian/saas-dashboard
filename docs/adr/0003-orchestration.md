# ADR-0003 — JobRunner interface now, Temporal in Phase 3

**Status:** Accepted · 2026-08-12

## Context

Onboarding, discovery, backfills and incremental syncs are long-running,
failure-prone, and must be resumable. Metadata discovery for a normal workspace
targets under 10 minutes and must survive a process restart without rescanning.

Temporal is the right target for durable execution. It is also a stateful
service cluster with real operational cost, and the execution contract for this
milestone forbids introducing Temporal infrastructure or scaffolding.

## Decision

Define a **`JobRunner` interface** and implement only an in-process runner now.

```ts
interface JobRunner {
  enqueue<T>(job: JobSpec<T>): Promise<JobHandle>;
  status(jobId: string): Promise<JobStatus>;
  cancel(jobId: string): Promise<void>;
}
```

`InProcessJobRunner` provides:

- Per-workspace serialization — one discovery per workspace at a time, so
  overlapping runs cannot interleave writes.
- Bounded global concurrency.
- **Checkpointing after each model**, persisted to `sync_runs.checkpoint`, so a
  crash resumes at the next unprocessed model rather than restarting.
- Idempotency keys on every side effect.
- Bounded retries with exponential backoff; permission errors are not retried.

Discovery is written entirely against `JobRunner`, never against the concrete
class, so Phase 3 replaces the implementation with a Temporal-backed adapter
without touching discovery logic.

**Temporal is an ADR, not a dependency.** No package, no worker, no
`infra/temporal/`, no docker-compose. Phase 3 introduces: `apps/worker`, Odoo
calls as retryable activities with idempotency keys, workflows for onboarding /
backfill / incremental sync, and Temporal's own retention and visibility config.

## Alternatives considered

**Temporal now.** Rejected: explicitly out of scope; would add a cluster before
the product has a second customer; premature operational burden.

**pg-boss / BullMQ.** A real queue on PostgreSQL or Redis. Rejected: it would
become the thing we migrate *off* in Phase 3, so it buys durability we do not
yet need at the cost of a second migration. The in-process runner is honest
about being temporary.

**n8n as the orchestrator.** Rejected by the specification and by judgment: core
SaaS correctness must not depend on customer-specific workflows. n8n stays an
edge adapter for Engosoft's existing pipelines.

**Nothing — run discovery inline in the request.** Rejected: a 10-minute request
is not resumable, not cancellable, and dies with the connection.

## Consequences

**Positive.** No new infrastructure; discovery is genuinely resumable today;
the Phase 3 swap is an adapter change; the checkpoint contract is exercised now
rather than designed on paper.

**Negative.** In-process jobs do not survive a process restart *in flight* — the
run is marked `interrupted` and resumes from its checkpoint on next trigger,
rather than resuming automatically. Jobs do not distribute across instances, so
a multi-instance deployment must pin workspace jobs to one instance or accept
that per-workspace serialization is per-instance. Both limitations are recorded
here and are the specific things Temporal fixes.

**Risk accepted.** Single-instance assumption for job execution until Phase 3.

## Verification

`tests/integration/discovery-resume.test.ts` — a run interrupted mid-model
resumes from its checkpoint, produces no duplicate models, and yields a snapshot
identical to an uninterrupted run.
