# Current → Target Migration Map

How each part of the existing Engosoft Insights Hub moves toward the multi-tenant
product. Status values: **KEEP** (unchanged), **EXTEND** (additive change this
milestone), **WRAP** (legacy adapter, flagged), **PACK** (becomes an industry /
metric pack), **REPLACE** (superseded later).

---

## 1. File-by-file

### `src/lib/` — server

| File | LOC | Status | Target |
| --- | --- | --- | --- |
| `odoo.server.ts` | 259 | **WRAP** | Stays for legacy routes. New `src/platform/odoo/` provides the per-workspace allowlisted connector. Legacy file gains no new callers. |
| `dashboard-db.server.ts` | 352 | **EXTEND** | Add nullable `workspace_id`; fix the `synced_at`-on-failure bug; keep the JSONB landing table as a compatibility layer. |
| `sheet-cache.server.ts` | 2,482 | **WRAP** | Engosoft's Sheets/n8n/Odoo arbitration. Untouched, behind `FEATURE_WORKSPACES=off`. Retired in Phase 3 when the durable data plane replaces it. |
| `metrics.server.ts` | 2,343 | **PACK** | `div`/`sumMaybe`/`pctOf` and the coverage guards extract to `metric-engine`. The Engosoft-shaped aggregations become the education pack. |
| `metric-catalog.ts` | 639 | **PACK** | Becomes the marketing metric pack's AR/EN copy + lineage layer; the shape (`formula`/`source`/`dateBasis`/`whenEmpty`) is exactly the explainability drawer contract. |
| `accounting-policy.ts` | — | **PACK** | Becomes `reporting_policies` rows: credit-note recognition + sign convention. |
| `reporting-window.ts` | 13 | **EXTEND** | Workspace-configurable window; `Africa/Cairo` becomes the workspace timezone. |
| `fx-rates.ts` | — | **EXTEND** | Becomes a versioned currency policy with a rate source. |
| `accounting-authority.ts`, `accounting-odoo.server.ts`, `accounting-courses.ts` | 917 | **PACK** | Education/accounting pack. |
| `crm-odoo.server.ts`, `sales-funnel.server.ts` | 753 | **PACK** | CRM/Sales pack; the Lost cohort-vs-movement split is a pack invariant. |
| `product-taxonomy.ts`, `products.server.ts` | 1,287 | **PACK** | Course/product taxonomy — education pack. |
| `google-ads.server.ts`, `tiktok.server.ts`, `meta-live-status.server.ts` | 1,082 | **KEEP** | Marketing connectors; per-workspace credentials in Phase 7. |
| `agent-analytics.server.ts` | 536 | **REPLACE** | Superseded by the Phase 6 copilot with approved-metric tools only. |
| `telegram.server.ts`, `subscribers.server.ts`, `scheduler.server.ts`, `cron.ts` | 716 | **KEEP** | Engosoft operational tooling; workspace-scoped later. |
| `i18n.tsx` | 558 | **KEEP** | Product-wide AR/EN. Extended with onboarding keys this milestone. |
| `navigation.ts` | 113 | **EXTEND** | Default IA; gains the flagged onboarding/settings entries. |
| `types.ts` | 753 | **KEEP** | Engosoft domain types; canonical types live beside them in `src/platform/`. |
| `api.server.ts` | 69 | **EXTEND** | `parseFilters` stays; workspace resolution added for new routes only. |

### `src/routes/api/` — 26 routes

**KEEP, unchanged.** Every existing route keeps its path, query contract and
response shape. New routes live under `/api/v1/**` and never collide.

### `src/components/`

`ui/**` (48 files), `charts.tsx`, `DataTable.tsx`, `metric-bits.tsx`,
`ui-bits.tsx` → **KEEP** as the design system.
`ads/verdict.ts`, `ads/owner-campaign-verdict.ts` → **PACK**.

---

## 2. New code added by this milestone

Everything new lands under `src/platform/` — the module boundary that a later
monorepo migration turns into packages (ADR-0006). No existing file moves.

```text
src/platform/
  db/            pool, workspace-scoped transactions, migration runner
  auth/          Better Auth config, membership + role checks
  secrets/       SecretStore interface, AES-256-GCM local adapter, prod guard
  odoo/          SafeOdooConnector, SSRF guard, permission probes
  discovery/     allowlist, discovery job, snapshot hashing
  jobs/          JobRunner interface + in-process runner
  workspace/     workspace context resolution, repositories
  audit/         append-only audit writer
  health/        data-health state
  flags/         feature-flag matrix
migrations/      NNNN_name.up.sql / .down.sql
tests/           unit / integration / security
```

---

## 3. Database migration plan

Additive and reversible. Two migrations.

### `0001_workspace_foundation`

**Creates (all new, no existing table touched):**

`organizations`, `workspaces`, `users`, `sessions`, `accounts`,
`verifications` (Better Auth), `memberships`, `roles`, `role_permissions`,
`odoo_connections`, `connection_secret_refs`, `schema_snapshots`,
`schema_models`, `schema_fields`, `schema_relations`, `permission_gaps`,
`onboarding_states`, `sync_runs`, `data_generations`,
`active_generation_pointers`, `audit_logs`.

**Also creates:** the `insights_app` runtime role (`NOBYPASSRLS`), RLS policies
on all workspace-owned tables, and the `set_workspace_context()` helper.

**Down:** drops exactly what it created, in dependency order. No existing data
is touched, so the down path is total.

### `0002_legacy_workspace_backfill`

- `ALTER TABLE dashboard_rows ADD COLUMN workspace_id uuid NULL` (+ index)
- `ALTER TABLE dashboard_sync_state ADD COLUMN workspace_id uuid NULL`
- Seeds the Engosoft organization + reference workspace with a **fixed UUID**
  (`00000000-0000-4000-8000-000000000001`) so the migration is idempotent.
- Backfills both legacy tables to that workspace id.

**Down:** drops the two columns and the seeded rows. Legacy readers ignore the
column entirely, so both directions are safe with the app running.

**Deliberately NOT in this milestone:** making `workspace_id` `NOT NULL` on the
legacy tables or enabling RLS on them. Both are irreversible-in-practice and
require the backfill to be verified in production first.

### Expand / migrate / contract

| Phase | This milestone | Later |
| --- | --- | --- |
| Expand | Nullable column + backfill | — |
| Migrate | Legacy reads ignore it; new code requires it | Legacy routes move to workspace-scoped reads |
| Contract | — | `NOT NULL` + RLS on legacy tables |

---

## 4. Feature-flag matrix

| Flag | Default | Controls | Off behaviour |
| --- | --- | --- | --- |
| `FEATURE_WORKSPACES` | `off` | `/api/v1/**`, onboarding UI, workspace nav | Routes 404; product is exactly as today |
| `FEATURE_ODOO_DISCOVERY` | `off` | Discovery job + snapshot UI | Connection test works; discovery unavailable |
| `FEATURE_LEGACY_DASHBOARD` | `on` | The 26 existing routes and 14 pages | Never turned off in this milestone |
| `SECRET_STORE_ADAPTER` | `local-aes-gcm` | Which SecretStore backs connections | `production` requires an explicit adapter or storage is refused |

With all flags at their defaults the deployed product is byte-for-byte the
current behaviour plus two unused nullable columns.

---

## 5. Bug fixed in passing

`markDashboardDatasetFailed` bumped `synced_at` to `now()` on failure
(audit §4.5), making a failed refresh look fresh. The `ON CONFLICT` clause now
preserves the existing `synced_at`, so freshness only advances on a successful
publish. Covered by `tests/unit/dashboard-db-freshness.test.ts`.

This is the one behaviour change to existing code in this milestone. It is a
correction toward the documented product principle, and the baseline records the
old behaviour as a known deviation.
