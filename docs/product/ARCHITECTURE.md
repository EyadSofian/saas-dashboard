# Architecture

Target architecture for InsightOS for Odoo, and the state of it after the
Workspace Onboarding Skeleton milestone.

---

## 1. Shape

Control plane / data plane, both on the existing TanStack Start + PostgreSQL
stack. Nothing is added for fashion; each choice has an ADR with its migration
cost and failure modes.

```text
                      ┌───────────────────────────────────┐
                      │   Browser (React 19, AR/EN, RTL)  │
                      └────────────────┬──────────────────┘
                                       │ session cookie
                      ┌────────────────▼──────────────────┐
                      │  TanStack Start server routes     │
                      │  /api/*      legacy (unchanged)   │
                      │  /api/v1/*   workspace-aware      │
                      └───┬───────────────┬───────────┬───┘
                          │               │           │
              ┌───────────▼──┐  ┌─────────▼──────┐  ┌─▼────────────┐
              │ Control plane│  │  Data plane    │  │ SecretStore  │
              │ orgs, wksp,  │  │  discovery,    │  │ AES-256-GCM  │
              │ members,     │  │  sync (P3),    │  │ → KMS (P3)   │
              │ connections, │  │  metrics (P4)  │  └──────────────┘
              │ snapshots,   │  └────────┬───────┘
              │ audit        │           │
              └───────┬──────┘           │
                      │                  │  allowlisted JSON-RPC only
              ┌───────▼──────────────────▼───┐   ┌──────────────────┐
              │ PostgreSQL (RLS, NOBYPASSRLS)│   │ Customer Odoo 17 │
              └──────────────────────────────┘   └──────────────────┘
```

### Control plane
Identity, organizations, workspaces, memberships, roles, Odoo connections and
secret references, schema snapshots, semantic mappings and approvals, metric
packs, dashboard definitions, job configuration, entitlements, audit, usage.

### Data plane
Odoo extraction, Bronze/Silver/Gold storage, metric queries and
materializations, workspace-scoped caches, and the AI tool surface over approved
metrics.

The two planes share one PostgreSQL instance for the MVP and are separated by
schema and by module boundary, so splitting them later is a deployment change
rather than a rewrite.

---

## 2. Module boundaries (this milestone)

A monorepo migration is **not** justified yet (ADR-0006). Equivalent boundaries
exist under `src/platform/*`, each with the dependency rules a package would
enforce:

| Module | Depends on | Must not depend on |
| --- | --- | --- |
| `contracts/` | — | anything |
| `db/` | contracts | odoo, auth, ui |
| `secrets/` | contracts | db, odoo |
| `auth/` | contracts, db | odoo, discovery |
| `workspace/` | contracts, db, auth | odoo, discovery |
| `odoo/` | contracts, secrets | db, auth, ui |
| `discovery/` | contracts, odoo, db, jobs | ui |
| `jobs/` | contracts | ui |
| `audit/`, `health/` | contracts, db | odoo |
| `flags/` | — | anything |

`odoo/` not depending on `db/` is what keeps the connector pure and testable
against a mock server with no database.

---

## 3. Isolation model

`workspace_id` is the only isolation key (see `TENANCY_INVARIANTS.md`).

Two enforcement layers, neither trusted alone:

1. **PostgreSQL RLS** — `FORCE`d on every workspace-owned table. The runtime
   role is `NOBYPASSRLS` and does not own the tables. Context is transaction-
   scoped `SET LOCAL app.workspace_id`.
2. **Application authorization** — membership resolved from the session, role
   checks per operation, repositories that will not build a query without a
   `WorkspaceContext`.

Missing context returns zero rows (RLS) *and* 403 (application). Both fail
closed.

---

## 4. Data architecture

Bronze / Silver / Gold, all in PostgreSQL for the MVP with an abstraction that
allows a later object-store or warehouse move. ClickHouse/BigQuery are not
introduced before volume requires them.

- **Bronze** — workspace-scoped raw Odoo records with source ids, `write_date`,
  sync run, schema snapshot and connector version. Allowlisted fields only.
- **Silver** — canonical dimensions and facts (`dim_*`, `fact_*`), each carrying
  `workspace_id`, source lineage, mapping version, UTC + workspace-local dates,
  company, currency, and an immutable `generation_id`.
- **Gold** — versioned metric definitions, materialized aggregates for common
  views, query-time metrics for flexible analysis, and a result cache keyed by
  workspace + generation + metric version + filters + watermark.

**Generations.** Any schema, mapping, metric-pack or policy change builds a new
immutable generation, validates and reconciles it in isolation, then atomically
flips `active_generation_pointers`. Queries pin exactly one generation; rows from
different mapping versions never mix. The previous generation is retained for
rollback.

This milestone creates the `data_generations` and `active_generation_pointers`
tables and has discovery write a generation, so the mechanism is real and
exercised before Phase 3 depends on it.

---

## 5. Orchestration

`JobRunner` is an interface (ADR-0003). This milestone ships the in-process
runner: bounded concurrency, per-workspace serialization, checkpointed and
resumable, idempotency keys on every side effect.

Temporal is the Phase 3 target and is an ADR only — no dependency, no scaffold,
no infrastructure in this milestone. Discovery is written against `JobRunner`
so the swap is an adapter, not a rewrite.

n8n remains an edge adapter for Engosoft's existing workflows. Core SaaS
correctness will not depend on customer-specific n8n workflows or Sheets.

---

## 6. Odoo access

`SafeOdooConnector` replaces the generic RPC passthrough for all new code:

- **Method allowlist:** `authenticate`, `version`, `fields_get`, `search_count`,
  `search_read`, `read`, approved `read_group`. Everything else is refused
  before a socket opens.
- **Model allowlist:** the discovery set plus permission-checked relations.
- **SSRF guard:** scheme, host, port, and post-DNS IP-range validation;
  redirects disabled; size and time bounds.
- **Stored fields preferred.** Non-stored computed fields require explicit
  approval, tighter limits, and shorter timeouts, because they can run arbitrary
  customer compute.
- **Per-workspace credentials** resolved through `SecretStore` at call time.

Odoo 17 is supported through a versioned adapter interface so 16/18 can be added
without touching callers.

---

## 7. Observability

OpenTelemetry for application traces, Langfuse for AI traces and prompt
versions, both with PII masking. Every span carries `workspace_id`. Secrets pass
through `redactSecrets()` before any log, trace, error or audit write.

Metrics that matter: mapping acceptance rate, reconciliation pass rate, sync
success and freshness, dashboard query p50/p95/p99, and cost per onboarded
workspace / sync / copilot answer.

---

## 8. What exists after this milestone

**Built:** module boundaries, migration runner, workspace schema + RLS,
Better Auth, `SecretStore` + local adapter + production guard, `SafeOdooConnector`
+ SSRF guard, connection test, `JobRunner` + resumable discovery, snapshot
persistence and viewer, audit log, data health, reference-workspace seed, and
the mock Odoo server with unit/integration/security tests.

**Interface-only (ADR, no code):** Temporal, KMS/Vault, semantic manifest
compiler, metric AST and query planner, dashboard runtime.

**Untouched:** all 26 legacy API routes, all 14 pages, the Sheets/n8n/Odoo
arbitration, and every existing environment variable.
