# InsightOS

Odoo analytics that understands your business. A multi-tenant SaaS: a company
connects a read-only Odoo database, the platform reads its schema, proposes what
each field means, the customer approves it, and dashboards are generated from
the approved mapping — not from code written per customer.

Arabic-first, with real RTL. English is the switch, not the baseline.

---

## The idea

Every Odoo implementation is customized. The same business concept lives in
different modules, custom fields, stages, companies and date fields, so a
traditional dashboard needs a data engineer to rediscover those definitions for
every customer.

This product turns that discovery into a reviewable pipeline:

```text
Odoo metadata  →  AI proposal with evidence  →  human approval
      →  versioned semantic manifest  →  deterministic sync
      →  typed metric engine  →  dashboards from a manifest
```

**AI proposes; deterministic, tested code computes.** A model classifies
metadata. It never writes SQL, never sees records, and never decides what
revenue means.

---

## Principles the code enforces

| Principle | Where it lives |
| --- | --- |
| Missing is never zero | `sync/canonical.ts` — Odoo's `false` becomes `null`, not `0` |
| A ratio over an empty denominator is unavailable | `metrics/engine.ts` — `safeRatio` returns `null` |
| An undated row cannot belong to a period | `metrics/engine.ts` — date filters exclude nulls |
| Money needs a human | `semantic/concepts.ts` — high-risk concepts always require approval |
| A failed refresh never blanks a healthy dashboard | `sync/run.ts` — the generation pointer only moves on success |
| One workspace can never read another | `migrations/0001` — RLS, forced, on every table |

---

## Getting started

```bash
npm install
```

Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `BETTER_AUTH_SECRET`
and `SECRET_STORE_ROOT_KEY`:

```bash
openssl rand -base64 32
```

```bash
npm run db:migrate
```

```bash
npm run dev
```

Then sign up, create a workspace, and connect Odoo at `/onboarding`.

---

## Verification

```bash
npm test
```

The suite starts a real PostgreSQL through `embedded-postgres` for the RLS,
migration and isolation tests — row-level security is a database guarantee, and
a mock would prove nothing. No test reaches the network: Odoo is a mock
JSON-RPC server, and the AI proposer takes an injected completion function.

```bash
npm run typecheck && npm run lint && npm run build
```

---

## Architecture

```text
src/platform/
  contracts/   Zod schemas, canonical serialization, hashing
  db/          pool, workspace transactions, migration runner
  auth/        Better Auth wiring
  secrets/     SecretStore interface + AES-256-GCM adapter
  odoo/        allowlisted read-only connector, SSRF guard
  discovery/   resumable metadata scan
  semantic/    concept catalog, proposers, validation, manifests
  sync/        extraction plans, canonical mapping, generations
  metrics/     typed definitions, planner, packs
  dashboards/  dashboard definitions and templates
  jobs/        JobRunner interface + in-process runner
```

`workspace_id` is the only isolation key. There is no `tenant_id`, and a test
fails the build if one appears.

### Security posture

- The Odoo connector is read-only by allowlist: forbidden methods and off-scope
  models are refused **before** any network call.
- Customer-supplied Odoo URLs pass an SSRF guard that resolves DNS and rejects
  private, loopback, link-local and IPv4-mapped addresses; redirects are refused.
- API keys are encrypted with AAD binding each ciphertext to its workspace and
  connection, so a ciphertext moved between rows fails to decrypt.
- The mapping model gets no tools, no network, no secrets and no write
  capability, and every path it returns is validated against the frozen schema
  snapshot — an invented field is dropped before it can be stored.

---

## Status

Built and tested: authentication, organizations and workspaces, secure Odoo
onboarding, schema discovery, AI semantic mapping with human approval, the sync
engine with generations, the metric engine, and dashboards rendered from
manifests.

Not yet built: durable workflow orchestration (jobs are in-process and do not
survive a restart mid-run — run a single replica), the AI copilot, marketing
connectors, usage metering and billing. See `docs/` for the roadmap.
