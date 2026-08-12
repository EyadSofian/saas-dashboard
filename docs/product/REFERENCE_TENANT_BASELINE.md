# Reference Workspace Baseline

The Engosoft installation is the product's reference workspace and the education
industry pack's source of truth. This document freezes what "still correct" means
so the migration can be verified.

**Hard rule: the baseline is captured from committed fixtures, never from
production.** No test, script, seed or migration in this repository may call the
live Odoo instance, the production database, or the production Sheets. The
fixtures below are synthetic data shaped like the real thing.

---

## 1. Reference workspace identity

| Field | Value |
| --- | --- |
| Organization | `Engosoft` |
| Organization id | `00000000-0000-4000-8000-000000000000` |
| Workspace | `Engosoft — Reference` |
| Workspace id | `00000000-0000-4000-8000-000000000001` |
| Timezone | `Africa/Cairo` |
| Locale | `ar-EG` |
| Base currency | `USD` |
| Companies | Odoo ids `2, 3, 4` (Egypt, KSA, UAE) |
| Reporting window start | `2026-01-01` |
| Industry pack | `education` |

Fixed UUIDs make the seed idempotent and let isolation tests reference the
reference workspace without a lookup.

---

## 2. Frozen policy decisions

These are the Engosoft answers to the questions onboarding will ask every new
customer. They become `reporting_policies` rows and the education pack's
defaults.

| Policy | Value | Source in current code |
| --- | --- | --- |
| Revenue recognition | `payment_date` (invoice basis selectable) | `accounting-policy.ts:15` |
| Credit-note recognition | Reversal **invoice** date | `accounting-policy.ts:14` |
| Credit-note sign | Negative | `accounting-policy.ts:18` |
| Lost acquisition cohort | Lead **creation** date | `metrics.server.ts:480` |
| Lost movement | **Close** date | `metrics.server.ts:573` |
| Currency | Convert at transaction date | `fx-rates.ts` |
| Default range | Year-to-date; `range=all` opts out | `api.server.ts:8-11` |
| Reporting end | Newest date present in source data | `reporting-window.ts:5` |
| Ratio on zero denominator | `null` → em dash | `metrics.server.ts:47` |
| Percentages | Recomputed from totals, never averaged | `metrics.server.ts:699` |
| Undated facts under a date filter | Excluded | `metrics.server.ts` |

---

## 3. Baseline invariants (assertions, not numbers)

Because fixtures are synthetic, the baseline asserts *properties* that must hold
for any input, which is stronger than pinning a number that would need updating
whenever a fixture changes.

| ID | Invariant | Tolerance |
| --- | --- | --- |
| B-1 | `div(x, 0) === null` for all `x` | exact |
| B-2 | `div(x, y)` is never `NaN` or `±Infinity` | exact |
| B-3 | `sumMaybe` over rows that all report `null` is `null`, not `0` | exact |
| B-4 | Aggregate CTR equals `Σclicks / Σimpressions`, not `avg(ctr)` | ≤ 1e-9 |
| B-5 | A credit note contributes a negative amount on its invoice date | exact |
| B-6 | Lost-by-cohort and Lost-by-movement differ when close ≠ creation month | exact |
| B-7 | `accountingReportingDate` returns invoice date for credit notes under **both** bases | exact |
| B-8 | Stable keys are deterministic: same row ⇒ same key across processes | exact |
| B-9 | Stable keys prefer an explicit id over the SHA-256 fallback | exact |
| B-10 | A failed dataset write does **not** advance `synced_at` | exact |
| B-11 | Every `MetricKey` in the catalog has AR + EN copy, a formula, a source, a date basis, and a `whenEmpty` reason | exact |
| B-12 | `parseFilters` maps unknown platform values to `undefined`, never a default platform | exact |

Financial reconciliation tolerance for future Silver-layer work: **0.5%** on
totals, **0 rows** on document counts. Anything outside blocks publication.

---

## 4. Route contract baseline

All 26 existing `/api/*` routes must keep responding with their current shape.
`tests/characterization/route-contracts.test.ts` asserts, for each route module,
that it still exports a `Route` with a `GET` (or documented `POST`) server
handler and that `/api/health` reports the nine known dataset keys:

```text
meta_ads · snap_ads · accounting · crm · lost
invoiced · website_sales · pbx_extensions · sla_calls
```

Full response-body snapshots need a seeded database and land with the Phase 3
integration environment; they are out of scope here, and the audit records that
gap honestly rather than claiming coverage that does not exist.

---

## 5. Known deviation introduced by this milestone

`markDashboardDatasetFailed` no longer advances `synced_at` on failure
(audit §4.5). The old behaviour was a defect: it made a failed refresh look
fresh. B-10 pins the corrected behaviour.

---

## 6. What is explicitly not baselined yet

- Rendered chart output (needs the Phase 4 visual-regression harness).
- Live Odoo row counts (would require production access — forbidden).
- Google Sheets arbitration outcomes (legacy path, frozen behind a flag).

These are stated so no one mistakes this document for full coverage.
