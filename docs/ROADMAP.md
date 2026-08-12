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

## Phase 2 — Durable orchestration

**Why now:** jobs are in-process. They do not survive a restart mid-run and do
not distribute, so the product is limited to a single replica. That is the
first thing that breaks under real customer load.

- Temporal workers, with each Odoo and AI call as a retryable activity carrying
  an idempotency key.
- Scheduled incremental sync per plan tier, with composite `(write_date, id)`
  watermarks persisted between runs rather than a full re-read.
- Tombstone handling: an Odoo record that is deleted, unposted, or that stops
  matching an approved domain must disappear from the canonical layer.
- Nightly full reconciliation to catch drift the incremental path missed.

**Exit:** killing a worker mid-sync resumes with no duplicate or missing rows;
two replicas can run without contending.

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

## Phase 4 — Validation and reconciliation

**Why now:** the product currently asks a customer to trust the mapping. It
should prove it instead.

- Row-count and total comparison against Odoo before a generation publishes.
- A reconciliation screen showing differences with drilldown to the record.
- Publication blocked on failed critical financial rules; explicit acceptance
  required for non-critical gaps.
- Data-quality rules per workspace with results surfaced in Data Health.

**Exit:** a customer can see, for their own data, that collected revenue matches
what Odoo reports, within a stated tolerance.

---

## Phase 5 — Dashboard builder

- Widget catalog and drag-to-arrange grid editor, with desktop and mobile
  layouts stored separately.
- Saved filter views; draft, publish, version, roll back.
- Natural-language dashboard creation that compiles to the same validated
  schema — a suggestion path, never a second way to define a metric.

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
