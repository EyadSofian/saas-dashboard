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

## Phase 3 — Production secret storage ◑ interim adapter shipped

`railway-aes-gcm` unblocks the first customers without AWS or Vault. Same
AES-256-GCM envelope encryption and AAD binding a KMS adapter would use; the
root key lives in the platform environment instead of behind a KMS API.

It reports `isProductionGrade: false` permanently and needs two explicit
variables to run in production, so nobody arrives there by copying a default.
Key versioning and a two-key rotation path are implemented, and a test scans
every text column of a real database for a canary credential.

**Accepted for 1–3 customers. The honest limitation:** anyone who can read the
process environment — deploy access, a shell on the service, the platform
itself — can decrypt every stored credential, and no decryption is logged.

**Replace with KMS/Vault when** someone gains deploy access who should not see
customer credentials, a customer asks how their key is protected, a fourth
customer connects, or a security review appears. See
`docs/runbooks/secret-store.md`.

**Still open:** the KMS adapter itself, a passed restore drill, and the
pinned-IP dialer closing the SSRF TOCTOU window.

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

## Phase 6 — AI copilot ✅ delivered

**Exit criterion met, as a control rather than a promise.** A system prompt
asking a model not to invent figures is a request. The enforcement is that every
number in a draft answer is checked against what the tools actually returned;
an unsourced figure means the answer is withheld, not shown.

Refusing is the right failure. A copilot that occasionally invents a revenue
total is worse than no copilot, because the invented one is indistinguishable
from the real ones.

- Four read-only tools: list metrics, query a metric, explain a metric, check
  freshness. No SQL, no table names, no record reads.
- **No tool takes a workspace parameter.** It comes from the session-resolved
  context, so "answer for workspace X" is not a question the model can be
  talked into answering.
- Presentation is tolerated, arithmetic is not: rounding 12,499.62 to 12,500 or
  quoting a ratio as a percentage passes; subtracting two real figures to
  produce a third does not, because arithmetic is where a copilot goes wrong
  quietly.
- Without an API key the copilot still answers — a deterministic path matches
  the question to metrics and renders the values. The numbers are identical
  either way, because both paths call the same tools.
- Adversarial tests cover injection in Arabic and English, admin-mode claims,
  requests for other workspaces, and a model that answers without calling
  anything.

**Still open:** deep links from an answer into the matching dashboard view, and
a larger golden question set with dialect coverage before broad release.

---

## Phase 7 — Commercial readiness ◑ partly delivered

**Delivered.** Three plans with real, enforced limits (connections, seats,
dashboards, synced rows, sync floor, copilot and AI mapping). Usage metering,
append-only. Workspace export excluding Odoo credentials — an export travels by
email and sits in a downloads folder, and the customer already has their own
key. Scheduled deletion with a seven-day grace period, executed by cascade
rather than an enumerated table list that would go stale. Retention that never
drops the active generation.

Entitlements deliberately meter what costs — databases, rows, frequency, seats,
AI — and never meter correctness. Selling accurate numbers as an upgrade would
mean shipping inaccurate ones as the default.

**Not delivered, and why.**

*Billing integration.* Needs a Stripe account and live keys. The entitlement
model it would attach to is finished, so this is a connector, not a redesign.

*SSO/SAML.* Enterprise procurement, not MVP. No first customer at Starter or
Growth will ask for it.

*Marketing connectors (Meta, Google, TikTok).* Genuinely large — per-workspace
OAuth, per-platform schemas, attribution joins with their own approval flow.
It is a second product surface, and shipping the Odoo one first is the right
order.

*Industry packs beyond the general catalog.* Worth doing once real customers
show which concepts they actually ask for. Guessing at them now is how a
catalog gets bloated with metrics nobody opens.

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
