# ADR-0001 — Authentication with Better Auth on existing PostgreSQL

**Status:** Accepted · 2026-08-12
**Deciders:** Platform engineering
**Supersedes:** nothing (there was no auth)

## Context

The audit (§4.1) found the product has **no authentication whatsoever**. No
session, cookie, login or bearer handling exists on any page or reporting route.
The only credential check anywhere is a shared secret on `/api/ingest/dataset`.

Multi-tenancy is impossible without identity: a workspace boundary needs a user
to attach a membership to. Authentication is therefore the first dependency of
every other Phase 1 item.

Constraints: keep the current TypeScript/TanStack stack; PostgreSQL is already
the system of record; the master specification forbids Clerk and Auth0.

## Decision

Adopt **Better Auth**, backed by the existing PostgreSQL database.

- Email + password to start; OAuth and SSO/SAML are additive later (Phase 7).
- Sessions are server-side records, not stateless JWTs, so they are revocable —
  which break-glass expiry and role changes both require.
- Auth tables (`users`, `sessions`, `accounts`, `verifications`) live in the
  same database and the same migration as the workspace tables, so a membership
  foreign key is a real constraint rather than a cross-service assumption.
- Cookies: `httpOnly`, `secure`, `sameSite=lax`. Rotation on privilege change.

Authorization is **not** Better Auth's job. Membership and roles are our own
tables, and PostgreSQL RLS is the enforcement layer beneath them (ADR-0004).

## Alternatives considered

**Clerk / Auth0 / WorkOS.** Fastest to ship and strong enterprise SSO. Rejected:
explicitly excluded by the specification; adds a per-seat cost to a product not
yet charging; puts identity in a system that cannot participate in a PostgreSQL
foreign key or transaction, which weakens the membership guarantee.

**Hand-rolled sessions.** Full control, no dependency. Rejected: password
hashing, session fixation, CSRF, rotation and verification flows are exactly the
surface where a hand-rolled implementation quietly fails.

**Lucia.** Comparable and lighter. Rejected: entered maintenance mode; Better
Auth has the more active trajectory and richer built-in organization primitives.

**NextAuth/Auth.js.** Rejected: Next-oriented; the TanStack Start adapter story
is weaker than Better Auth's.

## Consequences

**Positive.** Identity in the same transactional database as memberships; no
per-seat vendor cost; revocable sessions; a clear later path to SSO.

**Negative.** A meaningful new dependency in the auth-critical path, pinned in
the lockfile and requiring update discipline. Better Auth owns its table shapes,
so its migrations interleave with ours — the migration runner therefore records
them in the same ordered `schema_migrations` table.

**Risk accepted.** The 26 legacy routes stay unauthenticated in this milestone
(gap G-1). Adding auth to live routes would break the running dashboard, so it
is the first work item after this milestone rather than a silent change inside it.

## Verification

`tests/integration/auth.test.ts` — session creation, membership resolution,
rejection of unauthenticated and non-member access to `/api/v1/**`.
