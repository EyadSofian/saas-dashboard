// Canonical coercion and metric compilation.
//
// These are the two places a wrong answer is silent rather than loud: a `false`
// coerced to 0, or a ratio rendered as 0 because its denominator was empty.
import { describe, expect, it } from "vitest";
import {
  localDate,
  m2oId,
  m2oName,
  odooBoolean,
  odooDate,
  odooNumber,
  odooText,
  odooTimestamp,
  toCanonicalRow,
} from "@/platform/sync/canonical";
import {
  compileMetric,
  safeRatio,
  validateDefinition,
  MetricDefinitionError,
  type MetricDefinition,
} from "@/platform/metrics/engine";
import { ALL_METRICS, availableMetrics, metricMap } from "@/platform/metrics/packs";
import { buildExtractionPlans } from "@/platform/sync/plan";
import type { StoredMapping } from "@/platform/semantic/repository";

describe("Odoo value coercion", () => {
  it("treats false as absent, never as zero or empty string", () => {
    // Odoo returns `false` for every unset value regardless of type. Coercing
    // it to 0 makes "no revenue recorded" indistinguishable from "zero revenue".
    expect(odooNumber(false)).toBeNull();
    expect(odooText(false)).toBeNull();
    expect(m2oId(false)).toBeNull();
    expect(odooTimestamp(false)).toBeNull();
    expect(odooDate(false)).toBeNull();
  });

  it("keeps a real zero as zero", () => {
    expect(odooNumber(0)).toBe(0);
    expect(odooNumber("0")).toBe(0);
  });

  it("reads many2one tuples", () => {
    expect(m2oId([7, "Cairo Office"])).toBe(7);
    expect(m2oName([7, "Cairo Office"])).toBe("Cairo Office");
    expect(m2oName(false)).toBeNull();
  });

  it("normalises Odoo's naive UTC timestamps", () => {
    expect(odooTimestamp("2026-03-05 09:14:22")).toBe("2026-03-05T09:14:22.000Z");
    expect(odooDate("2026-03-05")).toBe("2026-03-05");
    expect(odooDate("2026-03-05 09:14:22")).toBe("2026-03-05");
  });

  it("rejects an unparseable timestamp rather than inventing one", () => {
    expect(odooTimestamp("not a date")).toBeNull();
  });

  it("reads booleans without turning empty into false", () => {
    expect(odooBoolean(true)).toBe(true);
    expect(odooBoolean(false)).toBe(false);
    expect(odooBoolean(null)).toBeNull();
    expect(odooBoolean("")).toBeNull();
  });
});

describe("workspace-local dates", () => {
  it("moves a late-evening UTC instant into the next local day", () => {
    // 23:30 UTC on the 31st is already the 1st in Riyadh. Reporting the
    // server's date would shift revenue between months for most of the region.
    expect(localDate("2026-03-31T23:30:00.000Z", "Asia/Riyadh")).toBe("2026-04-01");
    expect(localDate("2026-03-31T23:30:00.000Z", "UTC")).toBe("2026-03-31");
  });

  it("keeps a mid-day instant on the same day", () => {
    expect(localDate("2026-03-15T10:00:00.000Z", "Africa/Cairo")).toBe("2026-03-15");
  });

  it("falls back rather than throwing on an unknown timezone", () => {
    expect(localDate("2026-03-15T10:00:00.000Z", "Not/AZone")).toBe("2026-03-15");
  });

  it("returns null for a null instant", () => {
    expect(localDate(null, "UTC")).toBeNull();
  });
});

describe("canonical row building", () => {
  const plan = {
    entity: "invoice" as const,
    odooModel: "account.move",
    fields: ["id", "write_date", "invoice_date", "amount_total", "partner_id", "move_type"],
    columns: {
      "invoice.invoiceDate": "invoice_date",
      "invoice.amountTotal": "amount_total",
      "invoice.partner": "partner_id",
    },
    target: "fact_invoice",
    domain: [],
  };

  it("maps concepts onto canonical columns with the right types", () => {
    const row = toCanonicalRow(plan, {
      id: 42,
      write_date: "2026-03-05 09:00:00",
      invoice_date: "2026-03-01",
      amount_total: 1500.5,
      partner_id: [9, "ACME"],
      move_type: "out_invoice",
    });
    expect(row.source_id).toBe(42);
    expect(row.invoice_date).toBe("2026-03-01");
    expect(row.amount_total).toBe(1500.5);
    expect(row.partner_id).toBe(9);
    expect(row.is_credit_note).toBe(false);
  });

  it("identifies a credit note from its move type, not its amount sign", () => {
    // A negative total on a normal invoice is a discount, not a refund.
    const refund = toCanonicalRow(plan, {
      id: 43,
      move_type: "out_refund",
      amount_total: 500,
    });
    expect(refund.is_credit_note).toBe(true);

    const discounted = toCanonicalRow(plan, {
      id: 44,
      move_type: "out_invoice",
      amount_total: -200,
    });
    expect(discounted.is_credit_note).toBe(false);
  });

  it("leaves an unmapped value null rather than defaulting it", () => {
    const row = toCanonicalRow(plan, { id: 45, amount_total: false, partner_id: false });
    expect(row.amount_total).toBeNull();
    expect(row.partner_id).toBeNull();
  });
});

describe("extraction plans", () => {
  const mapping = (
    canonicalField: string,
    odooModel: string,
    odooField: string,
    status = "approved",
  ): StoredMapping => ({
    canonicalField,
    odooModel,
    odooField,
    relationPath: [],
    confidence: 1,
    evidence: [],
    alternatives: [],
    riskLevel: "high",
    requiresHumanApproval: true,
    status,
    explanationAr: "",
    explanationEn: "",
  });

  const entityModels = new Map([
    ["invoice", "account.move"],
    ["order", "sale.order"],
  ]);

  it("includes only approved mappings", () => {
    const plans = buildExtractionPlans({
      mappings: [
        mapping("invoice.amountTotal", "account.move", "amount_total", "approved"),
        mapping("invoice.invoiceDate", "account.move", "invoice_date", "needs_review"),
      ],
      entityModels,
      policies: {},
    });
    expect(plans).toHaveLength(1);
    expect(Object.keys(plans[0].columns)).toEqual(["invoice.amountTotal"]);
    // An unreviewed definition contributes no data at all.
    expect(plans[0].fields).not.toContain("invoice_date");
  });

  it("always requests id and write_date so incremental sync is possible", () => {
    const plans = buildExtractionPlans({
      mappings: [mapping("invoice.amountTotal", "account.move", "amount_total")],
      entityModels,
      policies: {},
    });
    expect(plans[0].fields).toContain("id");
    expect(plans[0].fields).toContain("write_date");
  });

  it("restricts invoices to posted customer documents", () => {
    const plans = buildExtractionPlans({
      mappings: [mapping("invoice.amountTotal", "account.move", "amount_total")],
      entityModels,
      policies: {},
    });
    expect(plans[0].domain).toEqual([
      ["move_type", "in", ["out_invoice", "out_refund"]],
      ["state", "=", "posted"],
    ]);
  });

  it("applies the approved order-counting policy", () => {
    const plans = buildExtractionPlans({
      mappings: [mapping("order.amountTotal", "sale.order", "amount_total")],
      entityModels,
      policies: { orderCounting: "confirmed_only" },
    });
    expect(plans[0].domain).toEqual([["state", "in", ["sale", "done"]]]);
  });

  it("orders dimensions before facts", () => {
    const plans = buildExtractionPlans({
      mappings: [
        mapping("invoice.amountTotal", "account.move", "amount_total"),
        mapping("company.name", "res.company", "name"),
      ],
      entityModels: new Map([...entityModels, ["company", "res.company"]]),
      policies: {},
    });
    // Only concepts in the catalog survive, but ordering must put any dimension
    // ahead of the facts that reference it.
    const entities = plans.map((p) => p.entity);
    if (entities.includes("company")) {
      expect(entities.indexOf("company")).toBeLessThan(entities.indexOf("invoice"));
    }
  });
});

describe("safeRatio", () => {
  it("returns null for a zero denominator", () => {
    expect(safeRatio(100, 0)).toBeNull();
  });

  it("returns null for a negative or missing denominator", () => {
    expect(safeRatio(100, -5)).toBeNull();
    expect(safeRatio(100, null)).toBeNull();
    expect(safeRatio(null, 100)).toBeNull();
  });

  it("never produces NaN or Infinity", () => {
    for (const [a, b] of [
      [1, 0],
      [0, 0],
      [-1, 0],
      [Number.MAX_VALUE, Number.MIN_VALUE],
    ] as const) {
      const result = safeRatio(a, b);
      if (result !== null) expect(Number.isFinite(result)).toBe(true);
    }
  });

  it("computes an ordinary ratio", () => {
    expect(safeRatio(50, 200)).toBe(0.25);
  });
});

describe("metric definition validation", () => {
  const base: MetricDefinition = {
    key: "test.metric",
    label: { ar: "", en: "" },
    table: "fact_invoice",
    grain: "document",
    aggregation: "sum",
    column: "amount_total",
    filters: [],
    dateColumn: "invoice_date",
    unit: "currency",
    fanoutPolicy: "forbid",
    allowedDimensions: ["company_id"],
    formula: { ar: "", en: "" },
    version: 1,
  };

  it("accepts a well-formed definition", () => {
    expect(() => validateDefinition(base)).not.toThrow();
  });

  it("rejects an unknown table", () => {
    expect(() => validateDefinition({ ...base, table: "secret_table" })).toThrow(
      MetricDefinitionError,
    );
  });

  it("rejects a SQL-injection-shaped column", () => {
    for (const column of ["amount; DROP TABLE users", "amount_total, (SELECT 1)", "1=1"]) {
      expect(() => validateDefinition({ ...base, column })).toThrow(MetricDefinitionError);
    }
  });

  it("rejects an injection-shaped dimension", () => {
    expect(() =>
      validateDefinition({ ...base, allowedDimensions: ["company_id; DELETE FROM fact_invoice"] }),
    ).toThrow(MetricDefinitionError);
  });

  it("rejects a ratio without both operands", () => {
    expect(() => validateDefinition({ ...base, aggregation: "ratio", numeratorKey: "a" })).toThrow(
      /numerator and a denominator/,
    );
  });

  it("refuses a line-grain count that would read as documents", () => {
    // Counting order lines while labelling the result "orders" multiplies the
    // number by the average basket size.
    expect(() =>
      validateDefinition({
        ...base,
        table: "fact_order_line",
        grain: "line",
        aggregation: "count",
        column: undefined,
        fanoutPolicy: "forbid",
      }),
    ).toThrow(/would count lines/);
  });
});

describe("metric compilation", () => {
  const definition = metricMap().get("accounting.invoiced")!;

  it("parameterizes the workspace and generation", () => {
    const { sql, params } = compileMetric(
      definition,
      { metricKeys: [definition.key] },
      "gen-1",
      "ws-1",
    );
    expect(sql).toContain("workspace_id = $1");
    expect(sql).toContain("generation_id = $2");
    expect(params[0]).toBe("ws-1");
    expect(params[1]).toBe("gen-1");
  });

  it("uses a half-open date range and excludes undated rows", () => {
    const { sql } = compileMetric(
      definition,
      { metricKeys: [definition.key], dateRange: { from: "2026-03-01", to: "2026-04-01" } },
      "gen-1",
      "ws-1",
    );
    expect(sql).toContain("invoice_date >=");
    expect(sql).toContain("invoice_date <");
    expect(sql).not.toContain("invoice_date <=");
    // A row with no date cannot belong to a period.
    expect(sql).toContain("invoice_date IS NOT NULL");
  });

  it("ignores a dimension that is not on the metric's allowlist", () => {
    const { sql } = compileMetric(
      definition,
      { metricKeys: [definition.key], dimensions: ["password", "company_id"] },
      "gen-1",
      "ws-1",
    );
    expect(sql).toContain("company_id");
    expect(sql).not.toContain("password");
  });

  it("never interpolates a caller-supplied filter column", () => {
    const { sql, params } = compileMetric(
      definition,
      {
        metricKeys: [definition.key],
        filters: [{ column: "amount_total); DROP TABLE users; --", op: "eq", value: 1 }],
      },
      "gen-1",
      "ws-1",
    );
    expect(sql).not.toContain("DROP TABLE");
    expect(params).not.toContain("DROP TABLE");
  });

  it("binds filter values as parameters, not literals", () => {
    const { sql, params } = compileMetric(
      definition,
      { metricKeys: [definition.key], filters: [{ column: "company_id", op: "eq", value: 7 }] },
      "gen-1",
      "ws-1",
    );
    expect(params).toContain(7);
    expect(sql).not.toContain(" = 7");
  });
});

describe("metric packs", () => {
  it("every shipped definition is valid", () => {
    for (const definition of ALL_METRICS) {
      expect(() => validateDefinition(definition), definition.key).not.toThrow();
    }
  });

  it("every definition carries a bilingual formula for the explainability drawer", () => {
    for (const definition of ALL_METRICS) {
      expect(definition.formula.ar.length, definition.key).toBeGreaterThan(0);
      expect(definition.formula.en.length, definition.key).toBeGreaterThan(0);
    }
  });

  it("keeps lost-movement and lost-cohort as separate metrics on different dates", () => {
    const movement = metricMap().get("crm.leads.lostMovement")!;
    const cohort = metricMap().get("crm.leads.lostCohort")!;
    expect(movement.dateColumn).toBe("closed_date_local");
    expect(cohort.dateColumn).toBe("created_date_local");
  });

  it("reports a metric as unavailable when its table was never populated", () => {
    const available = availableMetrics(new Set(["fact_lead"]));
    expect(available.map((m) => m.key)).toContain("crm.leads.new");
    // No payments mapped means no collected revenue — stated, not zeroed.
    expect(available.map((m) => m.key)).not.toContain("accounting.collected");
  });

  it("makes a ratio available only when both operands are", () => {
    expect(availableMetrics(new Set(["fact_lead"])).map((m) => m.key)).toContain(
      "crm.conversionRate",
    );
    expect(availableMetrics(new Set(["fact_order"])).map((m) => m.key)).not.toContain(
      "crm.conversionRate",
    );
  });
});
