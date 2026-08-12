// Reconciliation verdicts and tolerances.
//
// The judgement rules matter more than the plumbing: they decide whether a
// customer sees a number the ERP disagrees with.
import { describe, expect, it } from "vitest";
import {
  buildCheckSpecs,
  evaluate,
  QUALITY_RULES,
  verdictFor,
  type CheckResult,
  type CheckSpec,
} from "@/platform/reconciliation/checks";
import type { ExtractionPlan } from "@/platform/sync/plan";

const plan = (
  entity: ExtractionPlan["entity"],
  odooModel: string,
  columns: Record<string, string>,
  target: string,
): ExtractionPlan => ({
  entity,
  odooModel,
  fields: ["id", "write_date", ...Object.values(columns)],
  columns,
  target,
  domain: [["state", "=", "posted"]],
});

const spec = (over: Partial<CheckSpec> = {}): CheckSpec => ({
  key: "invoice.amount_total",
  entity: "invoice",
  measure: "sum",
  severity: "critical",
  canonicalColumn: "amount_total",
  odooField: "amount_total",
  tolerance: 0.005,
  label: { ar: "", en: "" },
  ...over,
});

describe("check specs", () => {
  it("checks a row count for every synced entity", () => {
    const specs = buildCheckSpecs([
      plan("invoice", "account.move", { "invoice.amountTotal": "amount_total" }, "fact_invoice"),
    ]);
    expect(specs.map((s) => s.key)).toContain("invoice.row_count");
  });

  it("treats financial counts as critical and dimensions as warnings", () => {
    const specs = buildCheckSpecs([
      plan("invoice", "account.move", {}, "fact_invoice"),
      plan("product", "product.product", {}, "dim_product"),
    ]);
    expect(specs.find((s) => s.key === "invoice.row_count")?.severity).toBe("critical");
    // A missing product name degrades a label, not a total.
    expect(specs.find((s) => s.key === "product.row_count")?.severity).toBe("warning");
  });

  it("only checks a sum the extract actually collected", () => {
    // Summing a column no approved mapping fills would compare zero against
    // Odoo's real total and fail for a reason nobody can act on.
    const withAmount = buildCheckSpecs([
      plan("invoice", "account.move", { "invoice.amountTotal": "amount_total" }, "fact_invoice"),
    ]);
    const withoutAmount = buildCheckSpecs([
      plan("invoice", "account.move", { "invoice.number": "name" }, "fact_invoice"),
    ]);

    expect(withAmount.map((s) => s.key)).toContain("invoice.amount_total");
    expect(withoutAmount.map((s) => s.key)).not.toContain("invoice.amount_total");
  });

  it("requires an exact match on counts and allows drift on amounts", () => {
    const specs = buildCheckSpecs([
      plan("invoice", "account.move", { "invoice.amountTotal": "amount_total" }, "fact_invoice"),
    ]);
    expect(specs.find((s) => s.measure === "row_count")?.tolerance).toBe(0);
    expect(specs.find((s) => s.measure === "sum")?.tolerance).toBeGreaterThan(0);
  });
});

describe("evaluate", () => {
  it("passes an exact match", () => {
    const result = evaluate(spec(), 100_000, 100_000);
    expect(result.passed).toBe(true);
    expect(result.difference).toBe(0);
  });

  it("passes rounding drift inside tolerance", () => {
    // 0.4% of a large total is currency rounding across thousands of lines.
    const result = evaluate(spec(), 100_000, 100_400);
    expect(result.passed).toBe(true);
  });

  it("fails drift beyond tolerance", () => {
    const result = evaluate(spec(), 100_000, 101_000);
    expect(result.passed).toBe(false);
    expect(result.difference).toBe(1_000);
  });

  it("judges relative to the source, so small totals are held to the same standard", () => {
    // The same absolute gap: rounding against 50,000, a real bug against 200.
    expect(evaluate(spec(), 50_000, 50_100).passed).toBe(true);
    expect(evaluate(spec(), 200, 300).passed).toBe(false);
  });

  it("requires exact equality when the source is zero", () => {
    // A relative tolerance around zero is meaningless.
    expect(evaluate(spec(), 0, 0).passed).toBe(true);
    expect(evaluate(spec(), 0, 1).passed).toBe(false);
  });

  it("requires an exact count match", () => {
    const countSpec = spec({ measure: "row_count", tolerance: 0, canonicalColumn: undefined });
    expect(evaluate(countSpec, 5_000, 5_000).passed).toBe(true);
    // A missing document is a missing document.
    expect(evaluate(countSpec, 5_000, 4_999).passed).toBe(false);
  });

  it("treats a null canonical sum as zero rather than as a pass", () => {
    // sum() over no rows is NULL. Against a real source total that is a
    // failure, not an absence of information.
    const result = evaluate(spec(), 100_000, null);
    expect(result.canonicalValue).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("records an unreadable source as unavailable, not as a mismatch", () => {
    // Reporting "0 vs 5,000" for a model we were not allowed to read would be
    // a lie in the other direction.
    const result = evaluate(spec(), null, 5_000, "access_denied");
    expect(result.passed).toBe(false);
    expect(result.unavailableReason).toBe("access_denied");
    expect(result.difference).toBeNull();
    expect(result.sourceValue).toBeNull();
  });
});

describe("verdict", () => {
  const result = (over: Partial<CheckResult>): CheckResult => ({
    key: "k",
    entity: "invoice",
    measure: "sum",
    severity: "critical",
    sourceValue: 100,
    canonicalValue: 100,
    difference: 0,
    tolerance: 0.005,
    passed: true,
    ...over,
  });

  it("passes when everything matches", () => {
    expect(verdictFor([result({}), result({})]).status).toBe("passed");
  });

  it("fails on a critical difference", () => {
    const verdict = verdictFor([result({ passed: false, severity: "critical" })]);
    expect(verdict.status).toBe("failed");
    expect(verdict.criticalFailures).toHaveLength(1);
  });

  it("asks for acceptance on a warning", () => {
    const verdict = verdictFor([result({ passed: false, severity: "warning" })]);
    expect(verdict.status).toBe("needs_acceptance");
    expect(verdict.warnings).toHaveLength(1);
  });

  it("a critical failure outranks any number of warnings", () => {
    // There is no note a person can write that makes a mismatched revenue
    // total safe to publish, so warnings cannot dilute it.
    const verdict = verdictFor([
      result({ passed: false, severity: "warning" }),
      result({ passed: false, severity: "warning" }),
      result({ passed: false, severity: "critical" }),
    ]);
    expect(verdict.status).toBe("failed");
  });

  it("treats an unavailable critical check as a failure", () => {
    // "We could not verify your revenue" must not publish as though verified.
    const verdict = verdictFor([
      result({ passed: false, severity: "critical", unavailableReason: "access_denied" }),
    ]);
    expect(verdict.status).toBe("failed");
  });
});

describe("quality rules", () => {
  it("flags missing dates and amounts as critical", () => {
    // Totals can match perfectly while every row carries a null date, which
    // makes every period report empty — reconciliation alone would not catch it.
    for (const key of ["invoice.missing_date", "payment.missing_date", "invoice.missing_amount"]) {
      expect(QUALITY_RULES.find((rule) => rule.key === key)?.severity).toBe("critical");
    }
  });

  it("uses fixed predicates, never interpolated input", () => {
    for (const rule of QUALITY_RULES) {
      expect(rule.predicate).not.toContain("$");
      expect(rule.predicate).not.toContain(";");
      expect(rule.table).toMatch(/^(fact|dim)_[a-z_]+$/);
    }
  });

  it("explains each rule in both languages", () => {
    for (const rule of QUALITY_RULES) {
      expect(rule.label.ar.length).toBeGreaterThan(0);
      expect(rule.label.en.length).toBeGreaterThan(0);
    }
  });

  it("catches a negative invoice that is not marked as a credit note", () => {
    const rule = QUALITY_RULES.find((r) => r.key === "invoice.negative_non_credit");
    expect(rule?.predicate).toContain("is_credit_note IS NOT TRUE");
  });
});
