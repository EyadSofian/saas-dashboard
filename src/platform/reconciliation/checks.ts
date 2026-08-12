// Reconciliation: proving the canonical layer matches Odoo.
//
// Without this the product asks a customer to trust a mapping they approved
// once. With it, the product answers "does your collected revenue match what
// Odoo says?" with a number and a tolerance.
//
// Three properties make a comparison honest rather than decorative:
//
//   • Same question. The check applies the *approved domain* the extract used.
//     Counting all invoices against a canonical layer that holds only posted
//     customer invoices would report a difference that is not an error.
//   • Same moment. It uses the generation's `source_upper_bound`, so rows
//     written after the extract are excluded from both sides.
//   • Honest unavailability. A permission gap is recorded as unavailable, not
//     as a mismatch — reporting "0 vs 5,000" for a model we were not allowed to
//     read would be a lie in the other direction.
import type { ExtractionPlan } from "../sync/plan";

export type CheckSeverity = "critical" | "warning" | "info";
export type CheckMeasure = "row_count" | "sum";

export interface CheckSpec {
  key: string;
  entity: string;
  measure: CheckMeasure;
  severity: CheckSeverity;
  /** Canonical column to sum. Omitted for row_count. */
  canonicalColumn?: string;
  /** Odoo field to sum via read_group. Omitted for row_count. */
  odooField?: string;
  /** Fractional. Counts are exact; amounts allow rounding drift. */
  tolerance: number;
  label: { ar: string; en: string };
}

/**
 * Amounts tolerate 0.5%: currency rounding, float representation and Odoo's own
 * per-line rounding make an exact match unrealistic across thousands of rows.
 * Counts tolerate nothing — a missing document is a missing document.
 */
const AMOUNT_TOLERANCE = 0.005;

/**
 * Which canonical column and Odoo field carry the money for each entity, and
 * how much it matters if they disagree.
 *
 * Money is critical: a difference blocks publication. A dimension row count is
 * a warning, because a missing product name degrades a label, not a total.
 */
const MEASURES: Record<string, { column: string; odooField: string; severity: CheckSeverity }> = {
  invoice: { column: "amount_total", odooField: "amount_total", severity: "critical" },
  payment: { column: "amount", odooField: "amount", severity: "critical" },
  order: { column: "amount_total", odooField: "amount_total", severity: "critical" },
  orderLine: { column: "subtotal", odooField: "price_subtotal", severity: "warning" },
  lead: { column: "expected_revenue", odooField: "expected_revenue", severity: "warning" },
};

const FINANCIAL_ENTITIES = new Set(["invoice", "payment", "order"]);

export function buildCheckSpecs(plans: ExtractionPlan[]): CheckSpec[] {
  const specs: CheckSpec[] = [];

  for (const plan of plans) {
    const financial = FINANCIAL_ENTITIES.has(plan.entity);

    specs.push({
      key: `${plan.entity}.row_count`,
      entity: plan.entity,
      measure: "row_count",
      severity: financial ? "critical" : "warning",
      tolerance: 0,
      label: {
        ar: `عدد سجلات ${plan.entity}`,
        en: `${plan.entity} record count`,
      },
    });

    const measure = MEASURES[plan.entity];
    // Only check a sum the extract actually collected: summing a column no
    // approved mapping fills would compare zero against Odoo's real total and
    // fail for a reason the customer cannot act on.
    const collected = Object.values(plan.columns).includes(measure?.odooField ?? "");
    if (measure && collected) {
      specs.push({
        key: `${plan.entity}.${measure.column}`,
        entity: plan.entity,
        measure: "sum",
        severity: measure.severity,
        canonicalColumn: measure.column,
        odooField: measure.odooField,
        tolerance: AMOUNT_TOLERANCE,
        label: {
          ar: `إجمالي ${plan.entity}`,
          en: `${plan.entity} total`,
        },
      });
    }
  }

  return specs;
}

export interface CheckResult {
  key: string;
  entity: string;
  measure: CheckMeasure;
  severity: CheckSeverity;
  sourceValue: number | null;
  canonicalValue: number | null;
  difference: number | null;
  tolerance: number;
  passed: boolean;
  unavailableReason?: string;
}

/**
 * Compares one measure.
 *
 * A difference is judged relative to the source value, not absolutely: 100
 * currency units out of 50,000 is rounding, and out of 200 is a bug. When the
 * source is zero the comparison falls back to absolute equality, because a
 * relative tolerance around zero is meaningless.
 */
export function evaluate(
  spec: CheckSpec,
  sourceValue: number | null,
  canonicalValue: number | null,
  unavailableReason?: string,
): CheckResult {
  const base = {
    key: spec.key,
    entity: spec.entity,
    measure: spec.measure,
    severity: spec.severity,
    tolerance: spec.tolerance,
  };

  if (unavailableReason || sourceValue === null) {
    // Not a pass and not a failure: we could not ask. Recording it as passed
    // would hide a permission gap behind a green tick.
    return {
      ...base,
      sourceValue: null,
      canonicalValue,
      difference: null,
      passed: false,
      unavailableReason: unavailableReason ?? "source_unavailable",
    };
  }

  const canonical = canonicalValue ?? 0;
  const difference = canonical - sourceValue;

  const passed =
    sourceValue === 0
      ? Math.abs(difference) < 1e-6
      : Math.abs(difference) / Math.abs(sourceValue) <= spec.tolerance;

  return { ...base, sourceValue, canonicalValue: canonical, difference, passed };
}

export interface ReconciliationVerdict {
  status: "passed" | "failed" | "needs_acceptance";
  criticalFailures: CheckResult[];
  warnings: CheckResult[];
}

/**
 * Decides whether a generation may publish.
 *
 * A critical failure blocks outright and cannot be accepted away: publishing a
 * revenue total that does not match the ERP is the one outcome this product
 * exists to prevent. A warning can be accepted by a human who states they know.
 */
export function verdictFor(results: CheckResult[]): ReconciliationVerdict {
  const failures = results.filter((result) => !result.passed);
  const criticalFailures = failures.filter((result) => result.severity === "critical");
  const warnings = failures.filter((result) => result.severity !== "critical");

  if (criticalFailures.length) return { status: "failed", criticalFailures, warnings };
  if (warnings.length) return { status: "needs_acceptance", criticalFailures: [], warnings };
  return { status: "passed", criticalFailures: [], warnings: [] };
}

/* ------------------------------------------------------------- quality -- */

export interface QualityRule {
  key: string;
  entity: string;
  table: string;
  severity: CheckSeverity;
  /** SQL predicate identifying a FAILING row. Fixed text, never user input. */
  predicate: string;
  label: { ar: string; en: string };
}

/**
 * Assertions about the canonical layer that need no source comparison.
 *
 * These catch the failures reconciliation cannot: totals can match perfectly
 * while every row carries a null date, which makes every period report empty.
 */
export const QUALITY_RULES: QualityRule[] = [
  {
    key: "invoice.missing_date",
    entity: "invoice",
    table: "fact_invoice",
    severity: "critical",
    predicate: "invoice_date IS NULL",
    label: {
      ar: "فواتير بدون تاريخ — مش هتظهر في أي تقرير بفترة",
      en: "Invoices with no date — they appear in no period report",
    },
  },
  {
    key: "payment.missing_date",
    entity: "payment",
    table: "fact_payment",
    severity: "critical",
    predicate: "payment_date IS NULL",
    label: {
      ar: "دفعات بدون تاريخ",
      en: "Payments with no date",
    },
  },
  {
    key: "invoice.missing_amount",
    entity: "invoice",
    table: "fact_invoice",
    severity: "critical",
    predicate: "amount_total IS NULL",
    label: {
      ar: "فواتير بدون قيمة",
      en: "Invoices with no amount",
    },
  },
  {
    key: "lead.missing_created",
    entity: "lead",
    table: "fact_lead",
    severity: "warning",
    predicate: "created_date_local IS NULL",
    label: {
      ar: "فرص بدون تاريخ إنشاء",
      en: "Leads with no creation date",
    },
  },
  {
    key: "order.missing_date",
    entity: "order",
    table: "fact_order",
    severity: "warning",
    predicate: "ordered_date_local IS NULL",
    label: {
      ar: "أوامر بدون تاريخ",
      en: "Orders with no date",
    },
  },
  {
    key: "invoice.negative_non_credit",
    entity: "invoice",
    table: "fact_invoice",
    severity: "warning",
    predicate: "amount_total < 0 AND is_credit_note IS NOT TRUE",
    label: {
      ar: "فواتير بقيمة سالبة مش مسجّلة كإشعار دائن",
      en: "Negative invoices not marked as credit notes",
    },
  },
];

export interface QualityResult {
  ruleKey: string;
  entity: string;
  severity: CheckSeverity;
  failingRows: number;
  totalRows: number;
  passed: boolean;
  detail: string;
}
