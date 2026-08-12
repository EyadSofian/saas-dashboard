# PRD — InsightOS for Odoo

## 1. Problem

Every Odoo implementation is customized. The same business concept lives in
different modules, custom fields, stages, companies, currencies and date fields.
Traditional dashboards need a data engineer to rediscover those definitions and
hand-build reports for each customer.

This product turns that discovery into a safe, AI-assisted onboarding process and
compiles the approved result into a reliable analytics product.

## 2. Thesis

It is **not** "an LLM writes SQL and UI for every customer". It is a semantic
compiler and a configurable analytics runtime:

```text
Odoo metadata + safe profiles
  → AI mapping proposal (evidence + confidence)
  → human approval for ambiguity and money
  → versioned Workspace Semantic Model
  → deterministic sync plans + metric engine + dashboard manifest
  → reusable renderer + explainable copilot
```

AI proposes; deterministic, tested code computes. Configuration precedes code
generation. Workspace-specific generated code is the exception, sandboxed and
shipped through a normal pull request.

## 3. Users

| User | Wants |
| --- | --- |
| Company owner | Fast, trustworthy view of revenue, pipeline, marketing efficiency, cash, problems |
| Department manager | Operational detail, targets, comparisons, drilldowns, action lists |
| Analyst / admin | Lineage, mapping control, metric definitions, quality tests, exports, dashboard building |
| Implementation partner | Onboard many Odoo customers quickly without forking code |

## 4. Ideal customer profile (V1)

Odoo 17 with CRM, Sales and Accounting. One to five companies in one database.
Arabic- or English-speaking management. Read-only analytics, no write-back.
First industry pack: **education / training**, seeded from the Engosoft
reference workspace.

## 5. Customer journey

A. Workspace and business profile → B. Secure Odoo connection →
C. Metadata discovery → D. Safe profiling → E. AI semantic proposal →
F. Mapping review studio → G. Validation and reconciliation →
H. Generate and publish.

Steps A–C plus permission checks and a read-only snapshot are delivered by the
**Workspace Onboarding Skeleton** milestone. D–H are Phase 2+.

## 6. Non-goals for V1

No arbitrary LLM SQL against production. No LLM writes to Odoo. No auto-approved
financial mappings. No ingesting every model and record by default. No per-
customer codebase fork. n8n/Sheets are not the authoritative core. Odoo 17 only,
behind an adapter interface. Missing values are never silently zero. No metric
without its date policy, source, formula and coverage. No monorepo rewrite before
characterization tests exist.

## 7. Principles

1. Trust before beauty — every number has lineage and a visible policy.
2. AI proposes; deterministic software computes.
3. Human approval for ambiguity; always for money.
4. No silent partial data — coverage is badged.
5. Workspace isolation everywhere.
6. Arabic is a first-class product language, tested not patched.
7. Read-only first.
8. Last-good serving — a failed refresh never blanks a healthy dashboard and
   never presents stale data as fresh.
9. Version everything.
10. Configuration before code generation.

## 8. Success criteria for the first sellable release

The 14 conditions in the master specification §24, of which this milestone
delivers: a customer can connect a read-only Odoo 17 account; discovery
completes without a developer reading fields by hand; failed discovery preserves
last-good and shows an honest state; two workspaces are proven isolated by
automated tests.

## 9. Packaging (designed now, billed later)

**Starter** — one Odoo database, CRM/Sales/Accounting, daily sync, limited users.
**Growth** — more companies/users, 30-minute sync, dashboard builder, marketing
connectors, AI copilot.
**Enterprise** — SSO, custom retention, dedicated isolation, premium connectors,
audit exports, onboarding support.

Metered by connected database, row volume, refresh frequency, seats, connectors,
AI usage and retention — never by withholding data-correctness features.

## 10. Performance objectives

Cached dashboard p95 < 1 s · uncached common metric p95 < 2 s · UI feedback
< 300 ms · connection test < 15 s · discovery < 10 min and resumable ·
AI proposal per domain < 90 s async · incremental freshness 15–30 min by plan ·
zero acknowledged financial data loss · zero cross-workspace exposure.
