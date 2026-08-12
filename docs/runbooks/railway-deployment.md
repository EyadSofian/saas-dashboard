# Runbook — Railway deployment

For deploying this repository as a Railway service. Read §1 before creating the
service: this repo serves company financial data on routes that have no
authentication, and a new Railway service means a new public URL.

---

## 1. Read this first — the unauthenticated surface

The 26 legacy reporting routes (`/api/overview`, `/api/accounting`,
`/api/leads`, …) and all 14 dashboard pages have **no authentication**
(`EXISTING_SYSTEM_AUDIT.md` §4.1, `SECURITY.md` G-1). This is pre-existing
behaviour, not something this milestone introduced.

On the current Engosoft deployment that risk is contained by the URL not being
advertised. **A new Railway service creates a second public URL serving the same
data.** Before making that service public, pick one:

| Option | Effect |
| --- | --- |
| Keep the service private / no public domain | Nothing is exposed; use Railway's private networking or a temporary domain you delete after testing |
| Put Railway's access control or a proxy in front | Blocks anonymous traffic at the edge; no code change |
| Deploy it, accept the exposure for a short test, then delete the domain | Acceptable only if the window is short and deliberate |

Authenticating the legacy routes is the first work item after this milestone.
Until then, treat any public URL for this repo as public financial data.

---

## 2. Environment variables

### Required for the app to boot

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Railway PostgreSQL reference | Use `${{Postgres.DATABASE_URL}}` |
| `PORT` | — | Railway sets it automatically |

### Required for the legacy dashboard (existing behaviour)

Copy these from the current Engosoft service — same names, same meaning, nothing
about them changed: `SHEET_ID`, `DASHBOARD_INGEST_SECRET`, `ODOO_URL`,
`ODOO_DB`, `ODOO_LOGIN`, `ODOO_API_KEY`, `ODOO_COMPANY_IDS`, `ODOO_START_DATE`,
`OPENAI_API_KEY`, and any of the TikTok / Google Ads / Telegram variables in
`.env.example` that the current service uses.

Without these the app still boots; the affected tabs report missing data
honestly rather than crashing.

### New — the multi-tenant platform

| Variable | Value | Required? |
| --- | --- | --- |
| `APP_ENV` | `staging` or `production` | **Yes** — see §3 |
| `FEATURE_WORKSPACES` | `0` to start | Yes |
| `FEATURE_ODOO_DISCOVERY` | `0` to start | Yes |
| `FEATURE_LEGACY_DASHBOARD` | `1` | Yes |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` | Only when workspaces are on |
| `SECRET_STORE_ADAPTER` | `local-aes-gcm` | Only when workspaces are on |
| `SECRET_STORE_ROOT_KEY` | `openssl rand -base64 32` | Only when workspaces are on |
| `PUBLIC_APP_URL` | `https://<service>.up.railway.app` | Only when workspaces are on |
| `ODOO_DEV_HOST_ALLOWLIST` | **leave unset** | Never set in production |

Generate the two keys:

```bash
openssl rand -base64 32
```

`SECRET_STORE_ROOT_KEY` must decode to exactly 32 bytes — the app refuses to
start the secret store otherwise, and refuses well-known all-zero test values.

**Losing `SECRET_STORE_ROOT_KEY` makes every stored Odoo credential
permanently undecryptable.** Store it somewhere you can recover it from.

---

## 3. `APP_ENV` — why it exists

Railway sets `NODE_ENV=production` to get an optimized build. That says nothing
about whether the deployment holds a real customer's ERP credentials, so the
secret-store guard keys off `APP_ENV` instead:

- `APP_ENV=production` (or unset) → storing a customer credential under the
  development AES-GCM adapter is **refused** with a 503. This is intended: a
  production secret store (AWS KMS / Vault) is ADR-0002, Phase 3.
- `APP_ENV=staging` → the local adapter is permitted, so onboarding can be
  tested end to end. Use test Odoo credentials only.

If you want to try the onboarding wizard on Railway, set `APP_ENV=staging` and
connect a **test** Odoo database — never a production one.

---

## 4. Deployment order

1. Create the service from the GitHub repo. Railway reads `railway.json`
   (`npm run build`, `npm run start`, healthcheck `/api/health`).
2. Add a PostgreSQL database and reference it as `DATABASE_URL`.
3. Set the environment variables from §2, with **all three feature flags at
   their defaults** (`FEATURE_WORKSPACES=0`, `FEATURE_ODOO_DISCOVERY=0`,
   `FEATURE_LEGACY_DASHBOARD=1`).
4. Deploy and confirm `/api/health` is green and the existing dashboard renders.

At this point nothing about the product's behaviour has changed. The workspace
code is deployed but dormant, and `/api/v1/*` returns 404.

### Turning the platform on

5. Run the migrations as a one-off command:

```bash
npm run db:migrate
```

6. Give the runtime role a login (migration 0001 creates it `NOLOGIN`):

```sql
ALTER ROLE insights_app WITH LOGIN PASSWORD '<generated>';
```

Then point `DATABASE_URL` at `insights_app` rather than the Postgres superuser.
This matters: the superuser owns the tables, and `FORCE ROW LEVEL SECURITY` is
the only thing stopping an owner connection reading every workspace.

7. Set `FEATURE_WORKSPACES=1` (and `FEATURE_ODOO_DISCOVERY=1` to allow scans),
   plus `BETTER_AUTH_SECRET`, `SECRET_STORE_ROOT_KEY` and `PUBLIC_APP_URL`.
8. Redeploy.

---

## 5. Migrations are not automatic

`startCommand` is deliberately just `npm run start`. Chaining
`db:migrate && start` would mean a transient database blip at boot takes the
**existing working dashboard** offline — trading a live product's availability
for the convenience of the dormant one.

Run `npm run db:migrate` as an explicit one-off command instead. It is
idempotent: re-running applies nothing, and it refuses to run if an
already-applied migration was edited.

Rollback:

```bash
npm run db:rollback
```

Twice returns the database to its pre-milestone shape. Legacy
`dashboard_rows` / `dashboard_sync_state` data survives both directions.

**Faster rollback with no schema change:** set `FEATURE_WORKSPACES=0` and
redeploy. Reach for a schema rollback only if the tables themselves are the
problem.

---

## 6. Post-deploy checks

- `/api/health` returns `ok: true` and lists the nine legacy datasets.
- The existing dashboard renders in Arabic and English.
- With flags off: `/api/v1/workspaces` returns 404, `/onboarding` shows the
  "feature not enabled" notice.
- With flags on: `/api/v1/workspaces` returns 401 when signed out.

If the dashboard shows stale data, check `status` on `/api/health` — a failed
refresh now keeps its old `syncedAt` instead of advancing it, so `failed` plus
an old timestamp is the honest signal rather than a fresh-looking lie.

---

## 7. What is not ready for production use

- Customer credential storage under `APP_ENV=production` (needs the KMS
  adapter — ADR-0002, Phase 3).
- Jobs do not survive a restart mid-run; they resume from their checkpoint on
  the next trigger and do not distribute across replicas. **Run a single
  replica** until Temporal lands (ADR-0003).
- No backup/restore drill has been run, so no backup readiness is claimed.
