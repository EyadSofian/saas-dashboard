# Roadmap

Milestone 1 is delivered. What follows is sequenced so each phase is useful on
its own rather than only as scaffolding for the next.

---

## Milestone 1 — Core product ✅ delivered

| Capability | State |
| --- | --- |
| Authentication | Better Auth on the same PostgreSQL as memberships |
| Organizations and workspaces | RLS-enforced isolation, roles, workspace switcher |
| Secure Odoo onboarding | Allowlisted read-only connector, SSRF guard, encrypted keys, resumable wizard |
| AI schema discovery | Resumable metadata scan, content-hashed snapshots, permission gaps |
| Semantic mapping | Concept catalog, deterministic + AI proposers, snapshot validation, human approval |
| Configurable dashboards | Sync into canonical generations, typed metric engine, manifest-driven widgets |

227 tests, including workspace isolation and migrations against a real
PostgreSQL.

---

## Phase 2 — Durable orchestration ✅ delivered

Jobs now live in PostgreSQL rather than in memory, so they survive a restart and
any replica can claim them.

- `job_queue` with lease-based claiming (`FOR UPDATE SKIP LOCKED`). A worker
  that dies lets its lease expire and another resumes from the checkpoint,
  rather than stranding the job behind a lock.
- Exponential backoff and an attempt budget; the checkpoint survives a retry so
  completed work is never repeated.
- Composite `(write_date, id)` watermarks with a 60-second overlap re-read,
  because Odoo writes many rows per second and second-precision `write_date`
  puts boundary rows on either side depending on commit order.
- Tombstones: records that vanished from Odoo are recorded and removed, so an
  incremental sync can subtract and not only add.
- Per-workspace schedules, with a partial unique index that makes a schedule
  firing during a manual run a no-op rather than a duplicate scan.

**Chose PostgreSQL over Temporal.** Temporal is the better answer once workflow
versioning, signals and long timers matter, but it is a stateful cluster to
operate and everything needed today is a durable queue with checkpoints. The
handler interface is unchanged, so swapping it later is an adapter.

**Still open:** a nightly full reconciliation pass, and running the worker as a
separate process (it currently runs inside the web process, which is correct at
this size but will want splitting under load).

---

## Phase 3 — Production secret storage

**Why now:** `APP_ENV=production` currently refuses to store customer
credentials at all, because the only adapter is development-grade. Until this
lands, the product cannot legitimately onboard a paying customer.

- `KmsSecretStore` (AWS KMS or Vault) with per-workspace data keys under a
  shared CMK, keeping the AAD binding.
- Root-key rotation with a re-encryption pass.
- Pinned-IP dialer to close the SSRF TOCTOU window between DNS resolution and
  connect.

**Exit:** a production deployment can store a real Odoo key; a restore drill has
been run and passed.

---

## Phase 4 — Validation and reconciliation ✅ delivered

The product no longer asks to be trusted; it shows the source value beside its
own for every measure.

- Row counts and money totals compared against Odoo before a generation
  publishes, using `search_count` and `read_group` so verifying a million rows
  costs one round trip rather than a second extract.
- The comparison applies the **same approved domain and the same upper bound**
  the extract used. Without both it would report differences that are not
  errors — all invoices against only posted ones, or rows written after the
  read.
- Counts must match exactly; money tolerates 0.5% for rounding, judged relative
  to the source so a gap that is rounding at 50,000 is a failure at 200.
- A critical difference **blocks** publication and has no acceptance path.
  Warnings can be accepted by a named person who states a reason.
- An unreadable model is recorded as unavailable, never as a mismatch —
  reporting "0 vs 5,000" for a model we were denied would be a lie in the other
  direction.
- Quality rules catch what reconciliation cannot: totals can match perfectly
  while every row carries a null date, which makes every period report empty.

**Still open:** drilldown from a failing check to the offending records.

---

## Phase 5 — Dashboard builder ✅ delivered

- Widget catalog (KPI, bars, table, text) with add, reorder, resize and remove.
  Reordering uses buttons rather than drag-and-drop so keyboard and phone users
  get the same capability; drag can be layered on top later, it cannot be the
  only way.
- Draft, publish, version and roll back. A published version is immutable —
  editing creates a new version and publishing promotes it, so "what was on the
  board last quarter" stays answerable and a rollback is republishing an old
  definition rather than rewriting history.
- Saved filter views, stored separately from dashboards so one view applies
  across several.
- Natural-language suggestions in Arabic and English, including mixed requests
  and the spelling variants people actually type. The output goes through the
  same validator as every other route — it is a faster way into the builder,
  never a second way to define a dashboard.
- A widget may only name a metric that exists **and** is answerable for this
  workspace. Without that check the builder cheerfully produces a board of em
  dashes, which reads as a broken product rather than an unmapped one.

**Still open:** separate stored layouts for mobile (spans currently adapt
responsively from one value), and drag-to-arrange as an addition.

---

## Phase 6 — AI copilot

- Filter-aware tools over **approved metrics only**; no SQL, no cross-workspace
  reach, no unapproved definitions.
- Every answer carries its period, filters, sources, formula and coverage, with
  a deep link to the drilldown.
- Arabic-aware retrieval over the glossary and mapping, including
  Egyptian/Gulf dialect and code-switching in evaluations.
- Golden evaluation sets before broad release: field mapping, business
  questions, prompt injection, cross-workspace attempts.

**Exit:** the copilot cannot produce a number that the dashboard would not.

---

## Phase 7 — Commercial readiness

- Marketing connectors with per-workspace credentials.
- Additional industry packs beyond the general catalog.
- Usage metering, plan entitlements, billing.
- SSO/SAML, workspace export and delete, retention policies.
- Runbooks, support tooling, onboarding analytics.

---

## Cross-cutting, not tied to a phase

| Item | Why it matters |
| --- | --- |
| CI pipeline, SBOM, dependency scanning | Nothing currently runs the suite except a person |
| Backup and restore drill | No readiness is claimed until a restore passes |
| Rate limits per workspace | One customer must not exhaust shared capacity |
| OpenTelemetry + AI tracing with PII masking | Cost and quality are unmeasurable without it |
| Accessibility and RTL visual regression | Arabic RTL is a product promise; it needs a test, not a review |
| Currency conversion with a versioned rate source | The policy exists; the rate source does not yet |
