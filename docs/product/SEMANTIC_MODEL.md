# Semantic Model

How a customer's Odoo becomes a set of trustworthy numbers.

```text
SchemaSnapshot        immutable, hashed description of the customer's Odoo
      ↓  (AI proposes, human approves — Phase 2)
SemanticManifest      versioned mapping of canonical concepts → Odoo paths
      ↓
Extraction plans      deterministic, generated from approved mappings only
      ↓
Canonical entities    dim_* / fact_* with lineage, generation, workspace
      ↓
Metric packs          typed, versioned metric definitions
      ↓
Dashboard manifests   data, not generated React
```

Each arrow is deterministic except the first, and the first always ends in human
approval.

---

## 1. Snapshot (built in this milestone)

An immutable, content-hashed description of the models, fields, relations,
selection values and permission gaps in one customer's Odoo, captured under one
connection at one point in time.

**Discovery allowlist** — the authorized scope, plus permission-checked
relations reached from it:

```text
crm.lead · crm.stage · crm.team
sale.order · sale.order.line
account.move · account.move.line
account.payment · account.partial.reconcile
res.company · res.currency · res.users
product.product · product.template · product.category
```

An unavailable model records a `PermissionGap` and discovery continues. The scan
is never broadened to all installed records.

Re-running discovery on unchanged metadata produces the same `contentHash` and
does **not** create a duplicate snapshot. A later Odoo customization creates a
*new* snapshot and a mapping-drift review; it never silently mutates an approved
semantic model.

Field labels, help text and selection labels are **untrusted customer data**
(threat T4). They are stored, displayed as data, and never interpolated into
instructions or query paths.

---

## 2. Manifest (Phase 2)

Canonical concepts mapped to Odoo paths, with status, confidence, evidence and
approver. Shape is fixed in the master specification §7 and reproduced in
`DATA_CONTRACTS.md`.

**Approval policy.** In V1 every AI-proposed mapping needs human approval.
Confidence is a *ranking signal*, not a calibrated probability — a model-written
`0.95` does not mean 95% correct. Below `0.70` is presented as unresolved, not
as a recommended default. Revenue, payments, refunds, tax, margin, profitability,
company/currency, lifecycle and date-policy mappings **always** require approval
regardless of confidence.

A future low-risk auto-accept path is permitted only after confidence is
calibrated per concept against held-out labelled data and the candidate passes
deterministic verification.

The model may select only from models, fields, relations and operators present in
the exact snapshot it was given. Invented paths are rejected.

---

## 3. Reporting policies

The questions onboarding must ask, because guessing them misstates money:

| Policy | Options |
| --- | --- |
| Revenue recognition | invoice date · payment date · reconciliation date |
| Credit-note recognition | original month · refund month |
| Credit-note sign | negative · separate measure |
| Lost cohort | lead creation date |
| Lost movement | close date |
| Currency conversion | transaction date · period-end · fixed rate |
| Company scope | which companies are included |
| Fiscal calendar | year start, period boundaries |

Engosoft's frozen answers are in `REFERENCE_TENANT_BASELINE.md` §2 and become the
education pack defaults.

**Two Lost questions, never conflated:** "how good were the leads acquired in
this period?" is a cohort by creation date; "how many leads closed Lost in this
period?" is movement by close date. The existing code already separates these
(`metrics.server.ts:480,573`) and the pack preserves it.

**Stage history is capability-dependent.** Current `crm.lead` state cannot
reconstruct an honest funnel history. Discovery detects whether
`mail.tracking.value` / chatter tracking / an audited snapshot stream is
available and permitted. If not, historical transition metrics are marked
**unavailable** and forward event snapshots begin at the connection date. A past
funnel is never invented.

---

## 4. Metric definitions (Phase 4)

Typed and versioned, per `MetricDefinition` in `DATA_CONTRACTS.md`. Aggregations
and filters are validated ASTs — data, never code — with an operator allowlist,
depth and node limits, and every field leaf resolved against the pinned snapshot.

**Grain and fan-out.** Each definition declares `baseGrain` and `fanoutPolicy`.
The planner validates entity grain and relationship cardinality before emitting a
plan, so an invoice total cannot multiply through invoice lines or a many-to-many
join. Where fan-out is permitted, aggregation happens at the metric's base grain
before the join, or under an explicitly approved distinct-entity policy.

### Correctness rules inherited from the current product

Ratios return `null` on a zero denominator and render as an em dash — never `0`,
`NaN` or `Infinity`. Percentages are recomputed from totals, never averaged.
Undated facts are excluded when a date filter is active. A ratio is not
comparable when cost and revenue coverage windows differ. Partial coverage is
visible and excludes a row from best/worst rankings. Period and lifetime metrics
are never shown together unlabelled. Active platform status is not date-filtered;
period spend/revenue/leads are. No percentage change without a complete
comparable baseline. Credit notes use an approved sign and recognition date.
Currency conversion uses a versioned approved rate source. Stable workspace-scoped
keys. Financial totals reconcile within tolerance before publication. Missing data
is unavailable, never zero.

### Explainability

Every metric card opens a drawer with: formula, numerator and denominator, entity
grain, included/excluded statuses, date field and timezone, currency policy,
source models and fields, last successful sync, coverage, and mapping version.

The existing `metric-catalog.ts` already carries `formula` / `what` / `how` /
`source` / `dateBasis` / `whenEmpty` per metric — it is the drawer contract,
already written in Arabic and English.

---

## 5. Domain packs

Versioned, reusable definitions. A workspace enables only the packs its approved
mappings support.

`crm` · `sales` · `accounting` · `marketing` · `website` · `operations`, plus
industry packs (`education` first, from Engosoft).

**Marketing attribution join priority:** exact platform/campaign/ad identifiers →
explicit approved Odoo campaign relation → approved normalized-name mapping →
unresolved bucket with a warning. An ambiguous name match is never silently
guessed.

**Website conversion campaigns** match an approved anchored regex or alias list
(e.g. `^web[-_ ]`), never an unbounded substring like `con` which would catch
unrelated names. A preview is shown before approval and unmatched rows stay
explicit.

**Profitability** is read only from approved Odoo cost/margin authorities. It is
never inferred from marketing spend or partial product cost.
