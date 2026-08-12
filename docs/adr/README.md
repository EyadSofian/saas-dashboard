# Architecture Decision Records

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-authentication-better-auth.md) | Better Auth on the existing PostgreSQL | Accepted |
| [0002](0002-secret-storage.md) | `SecretStore` interface, AES-256-GCM local adapter, production guard | Accepted |
| [0003](0003-orchestration.md) | `JobRunner` interface now, Temporal in Phase 3 | Accepted |
| [0004](0004-tenancy-model.md) | `workspace_id` as the sole isolation key, enforced by RLS | Accepted |
| [0005](0005-semantic-manifest.md) | Versioned semantic manifest as declarative data | Accepted (design) |
| [0006](0006-module-boundaries.md) | `src/platform/*` boundaries, monorepo deferred | Accepted |
| [0007](0007-metric-query-architecture.md) | Typed metric AST compiled to parameterized SQL | Accepted (design) |

Format: Context → Decision → Alternatives considered → Consequences → Verification.
An ADR is amended by a new ADR that supersedes it, never edited in place once Accepted.
