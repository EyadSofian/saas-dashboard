# ADR-0005 — Versioned semantic manifest as declarative data

**Status:** Accepted · 2026-08-12 (design fixed; compiler is Phase 2/4)

## Context

Every Odoo implementation differs. The naive answers are to fork the codebase
per customer, or to let an LLM generate SQL and UI per customer. The first does
not scale past a handful of customers; the second cannot be tested, reviewed,
versioned or trusted with money.

We need a representation of "what this customer's data means" that is
auditable, diffable, approvable and executable by deterministic code.

## Decision

A **versioned semantic manifest**: declarative data describing the mapping from
canonical business concepts to one workspace's Odoo paths.

- Per workspace, monotonically versioned, immutable once published.
- Pinned to exactly one `schemaSnapshotId` — mappings are only meaningful
  against the schema they were approved against.
- Every mapping carries `status`, `confidence`, `evidence`, `alternatives`,
  `riskLevel`, `requiresHumanApproval`, `approvedBy`, and an AR + EN explanation.
- Stored canonically and hashed for change detection and AI-input caching.

### The manifest contains no executable code

Transforms and formulas are a small validated **AST**, not strings of code or
SQL. Operator allowlist (closed, versioned), max depth 8, max 64 nodes, and every
field leaf must resolve inside the pinned snapshot. An unknown operator rejects
the whole manifest — fail-closed.

This is the single most important property: a manifest is data a customer can
approve, not code that runs because an LLM wrote it.

### AI proposes, humans approve, deterministic code executes

The mapping model may select only from models, fields, relations and operators
present in the exact snapshot supplied to it; invented paths are rejected before
storage. It receives no tools, no network, no secrets, no write capability. Odoo
labels and help text are customer-controlled and are delimited as data (threat
T4).

In V1 every mapping needs human approval. Confidence is a ranking signal, not a
calibrated probability; below `0.70` is shown as unresolved rather than as a
default. Money, lifecycle and date-policy mappings always need approval whatever
the confidence.

### A schema change never mutates an approved manifest

New metadata produces a new `SchemaSnapshot` and a mapping-drift review. The
approved manifest is immutable; drift is a reviewable event, not a silent edit.

## Alternatives considered

**Generate per-customer code.** Maximum flexibility. Rejected: untestable at
scale, unreviewable, a security surface, and it makes every customer a fork.

**dbt models per customer.** Real lineage and tests. Rejected: still per-customer
artefacts requiring an engineer, and it moves the product's core competence into
a tool the customer cannot approve in business language.

**Fixed hardcoded mappings.** Simple and fast. Rejected: it is exactly what the
product exists to eliminate — it only works when every customer's Odoo is
identical, which is never.

**LLM at query time.** Rejected: non-deterministic financial numbers, no
approval point, no caching, unbounded cost.

## Consequences

**Positive.** One codebase for all customers; mappings are diffable and
rollback-able; a business user can approve a mapping in Arabic; the compiler is
testable against fixtures; AI mistakes are caught at approval rather than in a
board report.

**Negative.** Substantial up-front schema work before any value ships — the full
Zod contract set must exist before the compiler starts. Manifest versioning adds
migration burden. Expressiveness is deliberately limited by the operator
allowlist, so genuinely unusual customer logic needs an allowlist extension with
a normal pull request rather than an ad-hoc escape hatch. That friction is the
point.

## Status of implementation

Contract shapes are fixed in `DATA_CONTRACTS.md` §3. This milestone builds the
snapshot layer the manifest pins to — including the untrusted-label handling and
content hashing — so Phase 2 authors the manifest against a real, exercised
foundation.
