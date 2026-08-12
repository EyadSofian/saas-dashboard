# ADR-0007 — Typed metric AST compiled to parameterized SQL

**Status:** Accepted · 2026-08-12 (design fixed; engine is Phase 4)

## Context

The product must answer metric queries whose definitions vary per workspace,
across dimensions and filters the customer chooses, in Arabic and English, with
lineage — and the numbers are financial. Two obvious approaches are both
disqualified: an LLM writing SQL at query time (non-deterministic money, no
approval point, unbounded cost, injection surface) and hand-written SQL per
customer (a fork per customer).

The existing product already proves the hard requirements. `metrics.server.ts`
routes every ratio through `div()`, which returns `null` on a zero denominator
so nothing surfaces as `0`/`NaN`/`Infinity`; it recomputes aggregate CTR from
summed totals rather than averaging percentages; and it suppresses ratios whose
revenue and spend coverage windows do not align. Any new engine must preserve
these or it is a regression.

## Decision

Metric definitions are **typed, versioned ASTs** compiled by deterministic code
into **parameterized SQL**. The LLM never emits SQL and never sees the database.

```text
MetricDefinition (AST, versioned, approved)
        + MetricQueryRequest (metrics, dimensions, filters, dateRange, tz)
        + SemanticManifest (pinned) + SchemaSnapshot (pinned)
                        ↓  planner: validate → plan → parameterize
                Parameterized SQL + bound values
                        ↓
        MetricResponse (value | null, coverage, lineage, versions)
```

### Validation before planning — the part that prevents wrong money

1. **Operator allowlist.** Closed, versioned set. Unknown operator ⇒ reject.
2. **Depth and size limits.** Max depth 8, max 64 nodes.
3. **Path resolution.** Every field leaf must exist in the pinned snapshot.
4. **Grain and cardinality.** The planner checks `baseGrain` against the
   relationship cardinality of every join. An invoice-grain metric joined to
   invoice lines without aggregation is a **planner error**, not a wrong number.
5. **Fan-out policy.** Each metric declares `forbid` | `aggregate_before_join` |
   `distinct_entity`. Permitted fan-out aggregates at base grain before joining.
6. **Dimension and join-path allowlists** per metric.

### Null and coverage discipline, carried forward

`value: null` plus `unavailableReason` for unavailable — never a fabricated `0`.
Ratios null on zero denominator. Percentages recomputed from totals. Undated
facts excluded under a date filter. Coverage ratio and warnings on every
response; partial coverage excludes a row from best/worst rankings.

### Dates

Half-open `[from, to)` in the workspace timezone. The UI may display an inclusive
end date but converts to the exclusive next-day boundary before querying. The
server converts to UTC once and echoes the policy in the response.

### Generations and caching

Every query pins exactly one `data_generation_id`; rows computed under different
mapping or policy versions never mix. Cache key is
`workspace + generation + metricVersion + mappingVersion + filters + watermark`,
so a republish invalidates naturally rather than by manual eviction.

## Alternatives considered

**LLM writes SQL at query time.** Rejected: non-deterministic financial results,
no approval point, injection surface, no caching, unbounded cost.

**Cube.js / MetricFlow.** Real semantic layers with solved fan-out handling.
Genuinely tempting. Rejected for V1: another service and another modelling
language in the critical path, per-workspace dynamic model generation is awkward,
and neither gives us the AR/EN explainability drawer or the approval workflow
that is the product's differentiator. Revisit if the planner grows beyond what
one team can maintain.

**dbt + materialized tables only.** Rejected: query-time flexibility is required
for arbitrary dimension/filter combinations; dbt is a batch tool.

**Hand-written SQL per metric.** What exists today. Rejected as the target: it is
per-customer work, which is the problem being solved. It remains correct as the
*education pack's* implementation until Phase 4 lifts it.

## Consequences

**Positive.** Financial numbers are deterministic and testable; the planner
catches double-counting structurally instead of hoping a human notices; lineage
and explainability fall out of the definition; approved metrics are the only
surface the copilot can reach.

**Negative.** A query planner is a serious piece of engineering with a long tail
of edge cases; the operator allowlist bounds expressiveness so unusual customer
logic needs an allowlist extension via pull request; planner bugs are systemic
rather than per-customer. Accepted deliberately: bounded expressiveness that is
correct beats unbounded expressiveness that is occasionally wrong about revenue.

## Verification (Phase 4)

Double-counting fixtures for one-to-many and many-to-many joins; zero-denominator
and null-propagation cases; timezone and half-open boundary cases; reconciliation
against fixture totals within 0.5% on amounts and 0 rows on document counts;
rejection of unknown operators, over-deep ASTs and unresolved paths.
