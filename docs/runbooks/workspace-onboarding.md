# Runbook — Workspace Onboarding Skeleton

Operational procedures for the multi-tenant foundation. Everything here is safe
to run locally; nothing in this repository contacts production.

---

## 1. Local setup

```bash
npm install
```

Set in `.env` (see `.env.example` for the full list):

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/insights_dev
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
SECRET_STORE_ROOT_KEY=$(openssl rand -base64 32)
FEATURE_WORKSPACES=1
FEATURE_ODOO_DISCOVERY=1
```

Then:

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

`db:seed` creates the Engosoft reference workspace plus two synthetic
workspaces (`alpha`, `beta`) with fixed UUIDs, which the isolation tests use.

---

## 2. Verification commands

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:security
```

```bash
npm run build
```

`npm test` starts a real PostgreSQL via `embedded-postgres` for the RLS and
migration suites — no system PostgreSQL required, and no external network.

Note: `npm run lint` reports pre-existing errors in legacy files (see
`EXISTING_SYSTEM_AUDIT.md`). New code is lint-clean; scope the linter to it:

```bash
npx eslint tests src/platform src/routes/api/v1 src/components/onboarding
```

---

## 3. Database roles

Two roles, and the distinction is what makes RLS meaningful (ADR-0004):

| Role | Used for | Properties |
| --- | --- | --- |
| admin (the migration user) | migrations, provisioning | owns the tables |
| `insights_app` | all application queries | `NOBYPASSRLS`, not the owner |

Migration 0001 creates `insights_app` with `NOLOGIN`. Before pointing the app at
it, grant a password:

```sql
ALTER ROLE insights_app WITH LOGIN PASSWORD '<generated>';
```

Then set the app's `DATABASE_URL` to that role. **Do not run the app as the
migration role** — it owns the tables and `FORCE ROW LEVEL SECURITY` is the only
thing standing between an owner connection and every workspace's data.

### "I ran a query and got zero rows"

Expected. The runtime role sees nothing without workspace context. In `psql`:

```sql
BEGIN;
SELECT set_config('app.workspace_id', '<workspace-uuid>', true);
SELECT * FROM odoo_connections;
COMMIT;
```

`SET LOCAL` semantics mean the context ends with the transaction.

---

## 4. Rollback

Migrations are reversible and verified by `tests/integration/migrations.test.ts`.

```bash
npm run db:rollback
```

Rolls back one migration. Running it twice removes both, restoring the database
to its pre-milestone shape. Legacy `dashboard_rows` / `dashboard_sync_state`
data survives both directions — 0002 only adds and removes a nullable column.

**Feature-flag rollback (preferred, no data change):** set
`FEATURE_WORKSPACES=0` and `FEATURE_ODOO_DISCOVERY=0` and redeploy. The
workspace routes 404, the onboarding UI shows an explanatory notice, and the
26 legacy routes are unaffected. Reach for a schema rollback only if the tables
themselves are the problem.

---

## 5. Onboarding a workspace

1. Sign in.
2. `POST /api/v1/workspaces` with organization/workspace name, timezone, locale,
   base currency. The caller becomes `workspace_owner`.
3. Open `/onboarding`, enter Odoo URL, database, login and API key.
   The key is encrypted server-side and never returned to the browser.
4. Run the connection test. Read permission is probed per model; a denial
   becomes a visible permission gap rather than a failed test.
5. Start discovery. It scans the allowlisted models plus permitted relations,
   checkpointing after each model.
6. Review the snapshot: model, field and relation counts, permission gaps, and
   the content hash.

The wizard is resumable: state lives on the server, so a reload or a different
device continues where the customer left off.

---

## 6. Incident procedures

### Discovery failed

Failure never destroys the previous snapshot. Check
`GET /api/v1/discovery` — `snapshot` is the last-good one, `latestRun` carries
the failure. Retry from the wizard; the run resumes from its checkpoint.

If it fails repeatedly, check `GET /api/v1/data-health` (`lastAttemptAt` moves,
`lastSuccessAt` does not) and `GET /api/v1/audit` for `discovery.failed`.

### Connection test says `blocked_target`

The SSRF guard refused the URL: non-https, credentials in the URL, a
non-standard port, or a hostname resolving to a private address. This is
working as intended. For a genuinely internal Odoo, add the host to
`ODOO_DEV_HOST_ALLOWLIST` **in a non-production environment only**.

### Connection test says `credential_unreadable`

Odoo was never contacted. The stored ciphertext did not survive the GCM check,
which has three causes and one shared fix:

- `SECRET_STORE_ROOT_KEY` changed or was regenerated (the common one — a
  redeploy without the variable pinned).
- The database was restored from a backup taken under a different root key.
- The ciphertext or its AAD binding was altered.

The reason is deliberately not distinguished to the caller, so do not try to
tell them apart from the UI. Recovery is the same either way: re-enter the Odoo
API key in the wizard and save — that re-encrypts under the current key. If the
original `SECRET_STORE_ROOT_KEY` still exists, restoring it also works and
avoids touching every workspace.

Check first whether it is one workspace or all of them: a single workspace
points at that row, all of them point at the root key.

### Suspected credential exposure

1. Rotate the Odoo API key in Odoo itself.
2. Re-submit the connection in the wizard (this rotates the stored ciphertext).
3. Check `GET /api/v1/audit` for `connection.secret_rotated`.

Audit metadata is redacted on write, so an audit record cannot itself be the
leak. If the root key is suspected, rotate `SECRET_STORE_ROOT_KEY` and
re-enter every connection credential — old ciphertexts become undecryptable by
design.

### Suspected cross-workspace leak — **stop and escalate**

```bash
npm run test:security
```

If `workspace-isolation.test.ts` fails, treat it as a live incident: do not
deploy, and report it before making any further change.

---

## 7. What this milestone does not cover

Honest limits, so nobody assumes coverage that does not exist:

- The 26 legacy reporting routes remain **unauthenticated** (SECURITY.md G-1).
- No CI pipeline yet (G-5).
- **No backup/restore drill has been run**, so no backup readiness is claimed (G-6).
- Legacy tables are not yet `NOT NULL` + RLS (G-4).
- Jobs are in-process: they do not survive a restart mid-run (they resume from
  the checkpoint on the next trigger) and do not distribute across instances.
  Temporal is Phase 3 (ADR-0003).
