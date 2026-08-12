# Tenancy Invariants

These are the rules that make the product safe to sell. They are enforced by
code and tests, not by convention. Breaking one is a stop-and-report event.

---

## 1. Terminology (canonical, non-negotiable)

```text
Organization = commercial / billing / top-level membership container
Workspace    = one isolated analytics environment; THE security boundary
Connection   = one Odoo database connection, owned by exactly one workspace
```

"Tenant" is a product word used in prose only. There is no `tenant_id` /
`tenantId` identifier anywhere in code, SQL, cache keys, traces or file names.
The only isolation key is **`workspace_id`** (`workspaceId` in TypeScript).

A CI guard (`npm run test:security`) fails the build if `tenant_id` or
`tenantId` appears in `src/` or `migrations/`.

An organization may own many workspaces. A workspace belongs to exactly one
organization. Data never crosses a workspace boundary, even inside one
organization.

---

## 2. The nine invariants

### INV-1 — Every workspace-owned row carries `workspace_id`

Non-null, typed `uuid`, referencing `workspaces(id)`. No workspace-owned table
may rely on a join to establish ownership. Unique constraints on
workspace-owned tables always include `workspace_id`.

### INV-2 — Row-Level Security is on, forced, and unbypassable at runtime

Every workspace-owned table has `ENABLE ROW LEVEL SECURITY` **and**
`FORCE ROW LEVEL SECURITY`. The runtime database role is created
`NOBYPASSRLS` and is not the table owner. Migrations run as a separate
administrative role.

Application-level authorization is layered *on top of* RLS. Neither layer is
trusted alone.

### INV-3 — Workspace context is transaction-scoped and fails closed

Context is set with `SET LOCAL app.workspace_id = $1` inside the same
transaction as the query. The RLS policy is:

```sql
USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
```

`current_setting(..., true)` returns NULL when unset; `workspace_id = NULL` is
NULL, which is not TRUE, so **no rows** are visible. Missing context yields
zero rows, never all rows.

A malformed (non-UUID) value raises and aborts the transaction. Both outcomes
are fail-closed.

### INV-4 — Pooled connections never inherit context

`SET LOCAL` is scoped to the transaction and unwinds on `COMMIT`/`ROLLBACK`.
Every workspace query therefore runs inside an explicit transaction. Code may
not use `SET` (session-scoped) for workspace context. A test asserts that a
connection returned to the pool and re-checked out sees no workspace.

### INV-5 — Workspace context comes from the session, never from the client

The workspace is resolved from the authenticated user's membership. A
client-supplied workspace id is treated as a *request* and validated against
membership before use. An unauthenticated request has no workspace and reaches
no workspace-owned table.

Failure to resolve → `403`, not a default workspace.

### INV-6 — Every derived artefact is workspace-scoped

Not just tables. Cache keys, job queues and idempotency keys, log/trace
attributes, export filenames and signed URLs, AI prompts and retrieval indexes,
metric result caches, and rate-limit buckets all carry `workspace_id`.

Module-level mutable state keyed by anything other than workspace is banned in
new code. (The four legacy instances are catalogued in the audit and stay
behind the legacy flag.)

### INV-7 — Secrets are references, never values

Workspace tables store a `SecretStore` reference (`connection_secret_refs`),
never ciphertext-in-a-column-you-can-select-and-decrypt-anywhere, and never
plaintext. A secret is decrypted only at the moment of an outbound Odoo call,
in server-only code, and is never returned to a client, logged, traced, put in
an error message, or included in an AI prompt.

### INV-8 — One generation at a time

Reads pin exactly one `data_generation_id` per workspace. Rows computed under
different mapping/policy versions are never mixed in one answer. Publication is
an atomic pointer flip; rollback is flipping it back.

*(Generations are defined in this milestone's schema and honoured by the
discovery snapshot path. Full Bronze/Silver generation flipping lands in
Phase 3.)*

### INV-9 — Isolation is proven by tests, not asserted

`tests/security/workspace-isolation.test.ts` runs against a **real PostgreSQL**
and proves Workspace A cannot reach Workspace B through: a repository-style
select, raw SQL with the filter omitted, an explicit cross-workspace `WHERE`, a
join, a subquery, an aggregate, `UPDATE`, `DELETE`, and `INSERT` claiming
another workspace's id. It also proves that the runtime role is `NOBYPASSRLS`,
that RLS is enabled and forced on all 15 workspace-owned tables, that pooled
connections retain no prior context, that interleaved workspaces do not bleed,
and that missing context returns zero rows.

The API surface is covered by the route guard, which resolves the workspace from
membership and returns 403 for a non-member (`src/platform/api/guard.ts`).

**Not yet covered, because the surfaces do not exist in this milestone:**
workspace-scoped cache keys, export files, and AI tool calls. Each is required
by INV-6 and must gain its own isolation test in the phase that introduces it —
Phase 3 for cache and jobs, Phase 6 for AI tools. Stating this here is
deliberate: an invariant nobody tests is a comment, not a control.

This suite is required to pass before any release.

---

## 3. Roles (RBAC, layered above RLS)

| Role | May do |
| --- | --- |
| `workspace_owner` | Membership, billing, secret rotation, break-glass authorization |
| `data_admin` | Connections, schema discovery, mappings, rebuilds, data quality |
| `financial_approver` | Approve revenue / payment / refund / tax / currency / margin / date policy |
| `dashboard_publisher` | Draft, publish, roll back dashboards |
| `analyst` | Query approved metrics, drill down, permitted exports |
| `viewer` | Read published dashboards only |

Roles are per-workspace, granted through `memberships`. Platform support staff
have **no standing access**; access requires audited, reason-bound,
time-limited break-glass that the customer approves and that auto-expires.

---

## 4. Legacy compatibility

Pre-existing tables `dashboard_rows` and `dashboard_sync_state` gain a
**nullable** `workspace_id` in this milestone so the change is additive and
reversible. `NULL` means "legacy Engosoft data, pre-workspace".

The reference-workspace backfill sets it to the Engosoft workspace id. Once the
backfill is verified, a later milestone makes the column `NOT NULL` and enables
RLS on these two tables. That tightening is explicitly **not** part of this
milestone, because it is not reversible without data loss.

Until then, legacy routes read these tables through the legacy adapter with
`FEATURE_WORKSPACES=off` semantics, exactly as today.
