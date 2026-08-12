# ADR-0006 — `src/platform/*` module boundaries, not a monorepo yet

**Status:** Accepted · 2026-08-12

## Context

The target structure in the master specification is a pnpm monorepo:
`apps/web`, `apps/worker`, and a dozen `packages/*`. The current repository is a
single Vite/TanStack application with 163 source files and zero tests.

A monorepo migration moves every file. Doing that *before* characterization
tests exist means a large, unreviewable diff over untested 14k-line metric logic
— precisely the risk the execution contract prohibits.

## Decision

Create the same boundaries **inside** the existing application under
`src/platform/*`, with explicit dependency rules, and defer the physical
monorepo split.

```text
src/platform/
  contracts/   Zod schemas, canonical serialization, hashing
  db/          pool, workspace transactions, migration runner
  auth/        Better Auth config, membership and role checks
  secrets/     SecretStore interface + adapters
  odoo/        SafeOdooConnector, SSRF guard, permission probes
  discovery/   allowlist, discovery job, snapshot hashing
  jobs/        JobRunner interface + in-process runner
  workspace/   context resolution, repositories
  audit/       append-only audit writer
  health/      data-health state
  flags/       feature flags
```

Dependency rules (documented in `ARCHITECTURE.md` §2) are the ones a package
manifest would enforce. The important ones: `contracts/` depends on nothing;
`odoo/` does not depend on `db/` or `auth/`, which keeps the connector pure and
testable against a mock server with no database; nothing in `platform/` imports
from `src/routes/` or `src/components/`.

No existing file moves. Legacy code keeps its paths.

**Migration trigger** — split into a monorepo when any one holds:

1. A separate worker process is deployed (Phase 3, Temporal), or
2. two or more applications share `packages/*`, or
3. build times exceed roughly 90 seconds, or
4. more than three engineers work concurrently in the tree.

At that point the split is a directory move plus package manifests, because the
dependency rules already hold.

## Alternatives considered

**Monorepo now.** Matches the target and avoids a second move. Rejected: a
whole-tree move with no test coverage, forbidden by the execution contract, and
it would delay every functional deliverable in this milestone.

**Keep adding to `src/lib/`.** No structure work at all. Rejected: `src/lib/` is
already 29 files and 14k lines of mixed concerns; adding tenancy, secrets and
connector code there would make the eventual extraction strictly harder.

**Separate repository for the platform.** Rejected: cross-repo versioning
overhead for one team and one deployable.

## Consequences

**Positive.** Boundaries exist and are enforceable by review today; new code is
already package-shaped; the eventual split is mechanical; this milestone's diff
is additive and readable.

**Negative.** Dependency rules are enforced by review and by an import lint rule
rather than by the package manager, so a determined mistake can still cross a
boundary. Two organizational patterns coexist (`src/lib/` legacy,
`src/platform/` new), which needs explaining to newcomers — the audit and this
ADR are that explanation. A second move is still coming.

## Verification

`tests/unit/module-boundaries.test.ts` — asserts that no file under
`src/platform/` imports from `src/routes/` or `src/components/`, and that
`contracts/` imports nothing from other platform modules.
