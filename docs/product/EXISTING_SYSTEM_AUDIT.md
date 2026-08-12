# Existing System Audit — Engosoft Insights Hub

**Audit date:** 2026-08-12
**Audited commit:** `43ff978` ("Make dashboard validation numeric-safe")
**Source repository:** `EyadSofian/Engosoft-Insights-Hub`
**This repository:** `EyadSofian/saas-dashboard` — cloned from the above with full
history (88 commits) so migration decisions keep their provenance.

This document is the Phase 0 anchor. Nothing in the Workspace Onboarding
Skeleton milestone may contradict it without an ADR.

---

## 1. What the product is today

A single-tenant Arabic/English analytics dashboard for one company (Engosoft),
covering marketing spend, CRM pipeline, sales, accounting collection, courses,
website sales, employee performance and PBX/SLA.

It is a working, in-use product. It is **not** a prototype, and the migration
must treat its behaviour as the reference baseline.

### Measured shape

| Metric | Value |
| --- | --- |
| Source files under `src/` | 163 |
| Lines in `src/lib/` | 13,983 |
| API routes (`src/routes/api/`) | 26 |
| Page routes | 14 |
| Commits of history | 88 |
| Test files | **0** |
| Database migrations | **0** (runtime `CREATE TABLE IF NOT EXISTS`) |

### Stack (confirmed from `package.json`)

TanStack Start `1.168` + TanStack Router `1.170`, React `19.2`, Vite `8`,
Nitro `3.0-beta`, TypeScript `5.8`, Tailwind `4.2`, Radix UI, TanStack Query
`5.101`, Recharts `2.15`, Zod `3.24`, `pg` `8.23`, `openai` `6.48`.
Node `>=22`. Deployment via Railway (`railway.json`, `nixpacks.toml`).

---

## 2. Architecture as built

```text
n8n workflows ──POST /api/ingest/dataset──▶ PostgreSQL dashboard_rows (JSONB)
Google Sheets ──gviz fetch────────────────▶ sheet-cache.server.ts (in-process cache)
Odoo 17 JSON-RPC ─────────────────────────▶ odoo.server.ts (env-configured, live reads)
                                                   │
                                                   ▼
                                    metrics.server.ts (2,343 LOC)
                                                   │
                                    /api/* route handlers (26)
                                                   │
                                    React pages + Recharts + i18n
```

Three data authorities coexist by design during an in-flight migration away from
Google Sheets:

1. **PostgreSQL `dashboard_rows`** — durable last-good landing table, written by
   authenticated n8n ingest. The intended long-term source.
2. **Google Sheets via gviz** — legacy fallback, still live for some tabs.
3. **Direct Odoo JSON-RPC** — used by Products/CRM/Accounting paths where
   freshness beats the 30-minute n8n cycle.

`sheet-cache.server.ts` (2,482 LOC) is the arbitration layer that decides which
authority wins per dataset and tracks staleness per tab.

---

## 3. Reliability patterns worth preserving

These are the product's real intellectual property. Every one must survive the
migration, generalised from "Engosoft" to "workspace".

| Pattern | Where | Why it matters |
| --- | --- | --- |
| `div()` returns `null` on zero denominator | `metrics.server.ts:47` | Ratios never surface as `0`/`NaN`/`Infinity`; render as em dash |
| `sumMaybe()` stays `null` when no row reports a value | `metrics.server.ts:69` | Missing ≠ zero |
| CTR recomputed from summed clicks/impressions | `metrics.server.ts:699` | Percentages are never averaged |
| Spend-coverage guard suppresses ratios | `metrics.server.ts:788,924` | A ratio whose revenue mostly predates its spend window is refused |
| Stable keys with explicit-ID preference, SHA-256 fallback | `dashboard-db.server.ts:153` | Idempotent upsert across re-ingests |
| Atomic `replace` inside one transaction | `dashboard-db.server.ts:303` | A rebuild cannot leave a half-written dataset |
| Last-good raw retention per tab | `sheet-cache.server.ts:154,824` | Failed refresh never blanks a healthy dashboard |
| Misrouted-tab rejection | `sheet-cache.server.ts:833` | gviz's positional fallback cannot silently poison a dataset |
| Retry policy that refuses to retry auth/access errors | `odoo.server.ts:163` | Fails fast on permission problems |
| Credit notes recognised on reversal date, signed negative | `accounting-policy.ts:14,18` | Cancellations hit the month they happened |
| Lost cohort vs Lost movement kept separate | `metrics.server.ts:480,573` | The two Lost questions never get conflated |
| Per-metric AR/EN copy incl. date basis + source | `metric-catalog.ts` (639 LOC) | Every card can already explain itself |

`metric-catalog.ts` is effectively a hand-written semantic layer for the
marketing domain. It becomes the seed of the education/marketing metric pack.

---

## 4. Blocking gaps for multi-tenancy

Ordered by severity for the authorized milestone.

### 4.1 There is no authentication — CRITICAL

Grep across all of `src/` finds no session, cookie, login, or bearer handling on
any page or reporting API route. The only credential check in the product is a
shared-secret comparison on `/api/ingest/dataset`
(`ingest.dataset.ts:11-20`, correctly using `timingSafeEqual`).

Every reporting route — `/api/overview`, `/api/accounting`, `/api/leads` and 23
others — serves company financial data to any unauthenticated caller that can
reach the origin. Today this is contained by Railway network placement, not by
the application.

**Consequence:** there is no user, no membership, and therefore no identity to
attach a workspace to. Authentication is the first thing Phase 1 must add, and
until it exists no workspace boundary can be enforced.

### 4.2 No workspace column anywhere — CRITICAL

`dashboard_rows` is keyed `(dataset, stable_key)` and `dashboard_sync_state` is
keyed `(dataset)`. Both are global. A second customer's rows written today would
collide with Engosoft's on identical Odoo IDs, silently overwriting them through
the `ON CONFLICT DO UPDATE`.

**Consequence:** the tables cannot accept a second tenant at all. They must be
extended additively with `workspace_id` and backfilled to a reference workspace.

### 4.3 The Odoo connector is a generic RPC passthrough — HIGH

`odooCall(model, method, args, kwargs)` (`odoo.server.ts:131`) forwards *any*
model and *any* method to `object.execute_kw`. There is no allowlist. In a
single-tenant deployment where only first-party code calls it, that is
acceptable. In a SaaS where mapping proposals and customer configuration can
influence arguments, it is an arbitrary-write primitive against the customer's
ERP.

Config is read from `process.env` per call (`odooConfig()`), and `uidCache` is a
module-level single-entry cache keyed by login+db — both are structurally
single-tenant.

### 4.4 No SSRF protection — HIGH

`rpc()` fetches `${cfg.url}/jsonrpc` with no scheme, host, or IP validation.
Safe while the URL is operator-supplied via env; unsafe the moment a customer
types it into an onboarding form.

### 4.5 Freshness lies on failure — MEDIUM (real bug)

`markDashboardDatasetFailed` (`dashboard-db.server.ts:337-352`) writes
`synced_at = now()` and, on conflict, applies `synced_at = EXCLUDED.synced_at`.
A **failed** refresh therefore advances the dataset's freshness timestamp while
leaving the stale rows in place.

`status` does flip to `'failed'`, so a consumer that reads `status` is safe, but
`/api/health` reports `syncedAt` alongside it and the value is wrong. This
directly violates the product principle "`syncedAt` changes only after a
successful publish."

Fix is one line and is in scope for this milestone (§4 of the migration map).

### 4.6 No migration system — MEDIUM

Schema is created lazily by `ensureSchema()` running
`CREATE TABLE IF NOT EXISTS` on first query, memoised in a module promise. There
is no version table, no ordering, no down path, and no way to review a schema
change. Multi-tenant tables with RLS cannot be managed this way.

### 4.7 No tests — MEDIUM

`package.json` declares no test runner. The three `scripts/*.mjs` files
(`reconcile.mjs`, `validate-dashboard.mjs`,
`build-official-campaign-status-workflow.mjs`) all read `process.env` and call
live systems, so they are operational tools, not a safety net, and must never be
wired into CI as-is.

Refactoring 14k lines of metric logic without characterization tests is the
single largest risk in this programme.

### 4.8 Single-tenant module state — MEDIUM

Module-level mutable caches that would leak across workspaces:
`uidCache` (`odoo.server.ts:61`), `pool`/`schemaPromise`
(`dashboard-db.server.ts:54-55`), `lastGoodRaw` (`sheet-cache.server.ts:154`),
`personTeamCache` (`metrics.server.ts:515`).

Each must become workspace-keyed or request-scoped before a second workspace
exists.

---

## 5. Classification of the existing code

### Reusable near-verbatim (generalise, don't rewrite)

- `metric-catalog.ts` — becomes the marketing metric pack's copy layer.
- `accounting-policy.ts`, `reporting-window.ts`, `fx-rates.ts` — become
  reporting-policy primitives.
- `i18n.tsx` (558 LOC) — AR/EN dictionary and RTL plumbing; product-wide.
- `navigation.ts` — becomes the default dashboard information architecture.
- `src/components/ui/**` (48 Radix wrappers) — the design system, tenant-neutral.
- `charts.tsx`, `DataTable.tsx`, `metric-bits.tsx` — renderer primitives.
- `div`/`sumMaybe`/`pctOf` discipline — moves into the metric engine core.

### Engosoft-specific — becomes the education industry pack

- Course taxonomy (`product-taxonomy.ts`, `accounting-courses.ts`).
- Media-buyer evaluation (`components/ads/verdict.ts`,
  `owner-campaign-verdict.ts`).
- Hardcoded company IDs `[2,3,4]` and start date `2026-01-01` (`odoo.server.ts:40-41`).
- `SHEET_ID`-driven tab names and the gviz arbitration in `sheet-cache.server.ts`.
- Telegram daily-report subscribers and cron.

### Must be replaced for SaaS

- `odoo.server.ts` env-global config → per-workspace connection + allowlisted connector.
- `dashboard-db.server.ts` runtime DDL → versioned migrations + RLS.
- Direct `process.env.ODOO_API_KEY` reads → `SecretStore`.
- Absent auth → Better Auth on the existing PostgreSQL.

### Must stay behind a legacy adapter for now

The whole Google-Sheets arbitration path in `sheet-cache.server.ts`. It is
load-bearing for Engosoft's live dashboards and is explicitly out of scope for
this milestone. It stays reachable behind the legacy compatibility flag.

---

## 6. Credential exposure check

Scanned all 88 commits across every ref for private keys, `sk-`/`xoxb-`/`AIza`
tokens, and credentialed PostgreSQL URLs. **No secrets found in history.**
`.gitignore` correctly excludes `.env` and `.env.*` while allowing
`.env.example`; the only tracked env file is `.env.example`, which contains
29 variable *names* and no values.

No rotation is required as a result of this audit. Note separately that live
credentials do exist in the Railway environment for the production deployment;
this milestone neither reads nor needs them.

---

## 7. Baseline behaviour this milestone must not change

- All 26 existing API routes keep their current paths, shapes and semantics.
- All 14 page routes render as before.
- Google Sheets / n8n / Odoo arbitration is untouched.
- `dashboard_rows` and `dashboard_sync_state` keep working for existing readers.
- No existing environment variable changes meaning.

New behaviour is additive and gated by `FEATURE_WORKSPACES`, default **off**.

See `REFERENCE_TENANT_BASELINE.md` for the recorded fixture baseline and
tolerances, and `CURRENT_TO_TARGET_MIGRATION_MAP.md` for the file-by-file plan.
