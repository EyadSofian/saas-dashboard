# ADR-0004 — workspace_id as the sole isolation key, enforced by RLS

**Status:** Accepted · 2026-08-12

## Context

The product must host many customers in one deployment. The existing schema has
no isolation key at all: `dashboard_rows` is keyed `(dataset, stable_key)` and
`dashboard_sync_state` by `(dataset)`, both global. A second customer's rows
would collide with Engosoft's on identical Odoo ids and silently overwrite them
through `ON CONFLICT DO UPDATE` (audit §4.2).

Two structural questions: what is the isolation key, and where is it enforced.

## Decision

### One key: `workspace_id`

```text
Organization = billing / membership container (may own many workspaces)
Workspace    = one isolated analytics environment — THE security boundary
Connection   = one Odoo database, owned by exactly one workspace
```

`workspace_id` (`workspaceId` in TypeScript) is the only isolation identifier.
No `tenant_id` / `tenantId` exists anywhere — a CI guard fails the build if one
appears in `src/` or `migrations/`. Two competing isolation keys is how
isolation bugs are born; "tenant" stays a prose word.

Isolation is per *workspace*, not per organization. Two workspaces in one
organization cannot see each other's data.

### Two enforcement layers

**Layer 1 — PostgreSQL RLS.** Every workspace-owned table has `ENABLE` **and**
`FORCE ROW LEVEL SECURITY`. The runtime role is `NOBYPASSRLS` and is not the
table owner; migrations run as a separate administrative role.

```sql
USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
```

Context is set with `SET LOCAL` inside the same transaction as the query.
`current_setting(..., true)` yields NULL when unset, and `workspace_id = NULL`
is NULL — not TRUE — so **missing context returns zero rows, never all rows**.
A malformed value raises and aborts. Both are fail-closed.

`SET LOCAL` unwinds at `COMMIT`/`ROLLBACK`, so a pooled connection cannot carry
one workspace's context into another's request. Session-scoped `SET` is banned.

**Layer 2 — application authorization.** Workspace resolved from the
authenticated session's membership, never from client input; role checks per
operation; repositories that refuse to build a query without a
`WorkspaceContext`.

Neither layer is trusted alone. A repository bug is caught by RLS; a database
misconfiguration is caught by the application check.

## Alternatives considered

**Schema-per-tenant.** Strong isolation, familiar. Rejected: thousands of
schemas make migrations O(tenants), connection pooling awkward, and
cross-workspace platform queries (usage, billing) painful. Revisit only for an
Enterprise dedicated-isolation tier.

**Database-per-tenant.** Strongest isolation, highest cost. Rejected for the
MVP; kept as an Enterprise option.

**Application-only filtering (`WHERE workspace_id = ?`).** Simplest, no database
role work. Rejected: one forgotten `WHERE` is a breach, and the failure is
silent. RLS makes the default deny.

**RLS only, no application checks.** Rejected: RLS cannot express role
permissions, and a single misconfiguration removes the only layer.

## Consequences

**Positive.** Default-deny isolation; a forgotten filter returns nothing instead
of everything; one migration path for all customers; cross-workspace platform
queries remain possible via the admin role.

**Negative.** Every workspace query must run in a transaction, which is a real
constraint on code style and is enforced by the repository layer. Two database
roles must be provisioned and kept correct. RLS adds a small per-query cost.
Developers must remember that a bare `psql` session as the runtime role sees
nothing — confusing until understood, and documented in the runbook.

**Legacy.** `dashboard_rows` / `dashboard_sync_state` get a **nullable**
`workspace_id` plus a backfill now. `NOT NULL` and RLS on those two tables are
deferred: they are not reversible without data loss and need the backfill
verified against production first.

## Verification

`tests/security/workspace-isolation.test.ts` — Workspace A cannot reach
Workspace B via API, repository, raw SQL on the runtime role, cache, export,
background job or AI tool surface; a pooled connection retains no prior context;
missing context returns zero rows; the runtime role cannot bypass RLS; a
`tenant_id` identifier appears nowhere in the tree.
