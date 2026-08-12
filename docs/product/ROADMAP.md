# Roadmap

Exit criteria are binding: a phase is not done until they pass.

---

## Phase 0 — Audit and safety net ✅ delivered

Audit, source-authority documentation, characterization tests for the metric
primitives, secret scanning, feature flags and migration adapters, architecture
docs and ADRs.

**Exit:** critical metric behaviour has automated coverage; no large refactor
started without a rollback path. **Met.**

---

## Phase 1 — SaaS foundation ✅ Workspace Onboarding Skeleton delivered

Authentication; organizations, workspaces, memberships, roles; workspace-aware
schema with RLS; encrypted Odoo connection records; workspace context in APIs,
jobs, caches and audit; Engosoft seeded as the reference workspace without losing
its dashboards. Plus, from the milestone scope: the safe connector, connection
test, resumable onboarding UI, metadata discovery over the allowlist, snapshot
persistence and viewer, and data health.

**Exit:** two test workspaces cannot reach each other through UI, API, direct
query, cache, export or AI. **Met** — see `tests/security/workspace-isolation.test.ts`.

**Immediately next (not in this milestone):** authenticate the 26 legacy
reporting routes (gap G-1).

---

## Phase 2 — Odoo discovery and mapping studio

Odoo 17 connector interface hardening; permission probes; module/model/field/
relation discovery beyond the initial allowlist; safe profiling with Arabic/Gulf
PII redaction; the structured AI mapping pipeline with evidence and confidence;
the mapping review and versioning UI; reporting-policy approval.

**Exit:** a new synthetic Odoo workspace reaches an approved semantic manifest
with **no code changes**.

Prerequisites: the full Zod contract set from `DATA_CONTRACTS.md` §3, and the
200-example golden mapping set plus adversarial injection fixtures.

---

## Phase 3 — Durable data plane

Temporal workflows and workers (ADR-0003); full and incremental sync with
`(write_date, id)` keyset pagination and composite watermarks; Bronze/Silver
canonical tables; tombstones, retries, validation gates, reconciliation,
last-good publish and generation flipping; data-health UI and alerts. Also
closes G-2 (pinned-IP dialer) and G-3 (KMS adapter).

**Exit:** killing a worker mid-sync resumes with no duplicate or missing
records; a partial extraction cannot replace healthy data.

---

## Phase 4 — Metric engine and template dashboards

Typed metric AST with operator allowlist and depth limits; query planner with
grain and fan-out validation; versioned metric packs; owner/manager/analyst
templates; explainability drawer and drilldowns; Arabic/English rendering.

**Exit:** CRM, Sales and Accounting packs work for Engosoft **plus at least two
synthetic workspaces with different custom fields**.

---

## Phase 5 — Custom dashboard builder

Widget catalog; grid editor with separate desktop and mobile layouts; saved
filter views; draft/publish/version/rollback; natural-language blueprint
suggestions that compile to the same validated schema.

---

## Phase 6 — AI copilot

Filter-aware metric tools over approved metrics only; evidence and deep links;
metadata/glossary retrieval with Arabic-aware normalization and hybrid retrieval;
evaluations, feedback, budgets and traces.

**Exit:** the copilot cannot use unapproved metrics, arbitrary SQL or
cross-workspace data; mapping and copilot golden evals pass agreed thresholds.

---

## Phase 7 — Connectors and commercial readiness

Marketing connectors with per-workspace credentials; industry packs; usage
metering and plan entitlements; billing; SSO/SAML; workspace export and delete;
runbooks, support tooling and onboarding analytics.

---

## Cross-cutting queue

| Item | Phase |
| --- | --- |
| Authenticate legacy reporting routes (G-1) | next |
| CI pipeline, SBOM, dependency scanning (G-5) | next |
| Backup/restore drill (G-6) | before first sale |
| Legacy tables `NOT NULL` + RLS (G-4) | after backfill verified |
| Retire Sheets arbitration | Phase 3 |
| 200-example golden mapping set | before Phase 2 ships |
| Load and chaos tests | Phase 3–4 |
| Accessibility and RTL visual regression | Phase 4 |
