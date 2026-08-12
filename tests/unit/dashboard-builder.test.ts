// Dashboard validation and natural-language suggestions.
//
// The property that matters: every route into a dashboard ends at the same
// validated schema, so a suggestion cannot produce something the builder would
// have rejected.
import { describe, expect, it } from "vitest";
import { blankWidget, validateDashboard } from "@/platform/dashboards/validate";
import { suggestDashboard } from "@/platform/dashboards/nl-builder";
import { DASHBOARD_TEMPLATES } from "@/platform/dashboards/templates";
import { metricMap } from "@/platform/metrics/packs";

const known = metricMap();
const allAvailable = new Set(known.keys());
const input = { known, available: allAvailable };

describe("validation", () => {
  it("accepts every shipped template", () => {
    // A template that would not survive the builder's own rules is a template
    // that teaches customers something the product then rejects.
    for (const template of DASHBOARD_TEMPLATES) {
      const result = validateDashboard(template.definition, input);
      expect(result.issues, template.key).toEqual([]);
      expect(result.ok, template.key).toBe(true);
    }
  });

  it("rejects a metric that does not exist", () => {
    const result = validateDashboard(
      {
        version: 1,
        widgets: [
          {
            id: "w1",
            kind: "kpi",
            title: { ar: "x", en: "x" },
            metricKeys: ["revenue.invented"],
            span: 3,
          },
        ],
      },
      input,
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0].reason).toBe("unknown_metric");
  });

  it("reports a real metric the workspace cannot answer yet", () => {
    // Known but unmapped: saying so beats rendering a dash forever.
    const result = validateDashboard(
      {
        version: 1,
        widgets: [
          {
            id: "w1",
            kind: "kpi",
            title: { ar: "x", en: "x" },
            metricKeys: ["accounting.collected"],
            span: 3,
          },
        ],
      },
      { known, available: new Set(["crm.leads.new"]) },
    );
    expect(result.issues[0].reason).toBe("metric_unavailable");
  });

  it("rejects a dimension the metric does not support", () => {
    const result = validateDashboard(
      {
        version: 1,
        widgets: [
          {
            id: "w1",
            kind: "bar",
            title: { ar: "x", en: "x" },
            metricKeys: ["accounting.collected"],
            dimension: "stage_id",
            span: 6,
          },
        ],
      },
      input,
    );
    expect(result.issues.some((issue) => issue.reason === "unknown_dimension")).toBe(true);
  });

  it("holds each widget kind to the number of metrics it can render", () => {
    const tooMany = validateDashboard(
      {
        version: 1,
        widgets: [
          {
            id: "w1",
            kind: "kpi",
            title: { ar: "x", en: "x" },
            metricKeys: ["crm.leads.new", "crm.leads.won"],
            span: 3,
          },
        ],
      },
      input,
    );
    // A KPI card shows one number; two would render one and silently drop the other.
    expect(tooMany.issues[0].reason).toBe("too_many_metrics");

    const tooFew = validateDashboard(
      {
        version: 1,
        widgets: [{ id: "w1", kind: "bar", title: { ar: "x", en: "x" }, metricKeys: [], span: 6 }],
      },
      input,
    );
    expect(tooFew.issues[0].reason).toBe("metric_required");
  });

  it("allows a text widget with no metric", () => {
    const result = validateDashboard(
      {
        version: 1,
        widgets: [
          {
            id: "w1",
            kind: "text",
            title: { ar: "x", en: "x" },
            metricKeys: [],
            span: 12,
            body: { ar: "ملاحظة", en: "note" },
          },
        ],
      },
      input,
    );
    expect(result.ok).toBe(true);
  });

  it("catches duplicate widget ids", () => {
    const widget = {
      id: "same",
      kind: "kpi" as const,
      title: { ar: "x", en: "x" },
      metricKeys: ["crm.leads.new"],
      span: 3,
    };
    const result = validateDashboard({ version: 1, widgets: [widget, { ...widget }] }, input);
    expect(result.issues.some((issue) => issue.reason === "duplicate_id")).toBe(true);
  });

  it("rejects a malformed definition outright", () => {
    expect(validateDashboard({ nonsense: true }, input).definition).toBeNull();
    expect(validateDashboard(null, input).ok).toBe(false);
  });

  it("rejects an unknown widget kind rather than rendering nothing", () => {
    const result = validateDashboard(
      {
        version: 1,
        widgets: [{ id: "w1", kind: "pie", title: { ar: "x", en: "x" }, metricKeys: [], span: 6 }],
      },
      input,
    );
    expect(result.ok).toBe(false);
  });

  it("produces a valid blank widget", () => {
    const widget = blankWidget("kpi", 0);
    expect(widget.span).toBe(3);
    expect(widget.metricKeys).toEqual([]);
  });
});

describe("natural-language suggestions", () => {
  const suggest = (request: string, available = allAvailable) =>
    suggestDashboard({ request, known, available });

  it("matches English metric words", () => {
    const result = suggest("show me collected cash and new leads");
    expect(result.matchedMetrics).toContain("accounting.collected");
    expect(result.matchedMetrics).toContain("crm.leads.new");
  });

  it("matches Arabic metric words", () => {
    const result = suggest("عايز أشوف المحصّل والفرص الجديدة");
    expect(result.matchedMetrics).toContain("accounting.collected");
    expect(result.matchedMetrics).toContain("crm.leads.new");
  });

  it("normalises Arabic spelling variants people actually type", () => {
    // Alef forms and taa marbuta are omitted or swapped constantly; a matcher
    // that only accepts the formal spelling matches almost nothing in practice.
    expect(suggest("الاوامر").matchedMetrics).toContain("sales.orders.count");
    expect(suggest("الأوامر").matchedMetrics).toContain("sales.orders.count");
  });

  it("handles a mixed Arabic/English request", () => {
    const result = suggest("عايز revenue و conversion rate");
    expect(result.matchedMetrics).toContain("accounting.invoiced");
    expect(result.matchedMetrics).toContain("crm.conversionRate");
  });

  it("produces a breakdown when the request asks for one", () => {
    const result = suggest("order value by salesperson");
    const widget = result.definition.widgets[0];
    expect(widget.dimension).toBe("user_id");
    expect(widget.kind).toBe("bar");
  });

  it("falls back to a KPI when the metric cannot take that dimension", () => {
    // Asking to break a ratio down by salesperson is reasonable to say and
    // impossible to answer; a card is better than a chart that lies.
    const result = suggest("conversion rate by salesperson");
    const widget = result.definition.widgets.find((w) =>
      w.metricKeys.includes("crm.conversionRate"),
    );
    expect(widget?.dimension).toBeUndefined();
    expect(widget?.kind).toBe("kpi");
  });

  it("reports requested metrics the workspace cannot answer instead of adding them", () => {
    const result = suggest("collected cash and new leads", new Set(["crm.leads.new"]));
    expect(result.matchedMetrics).toEqual(["crm.leads.new"]);
    expect(result.unavailableMetrics).toContain("accounting.collected");

    // Absent from every metric widget...
    const metricWidgets = result.definition.widgets.filter((w) => w.kind !== "text");
    expect(metricWidgets.flatMap((w) => w.metricKeys)).not.toContain("accounting.collected");
    // ...but explained on the dashboard rather than silently dropped.
    expect(result.definition.widgets.some((w) => w.kind === "text")).toBe(true);
  });

  it("reports an empty result rather than inventing a dashboard", () => {
    const result = suggest("make me something nice please");
    expect(result.empty).toBe(true);
    expect(result.definition.widgets).toEqual([]);
  });

  it("always produces something the validator accepts", () => {
    // The whole point: natural language is a faster route to the builder, not
    // a second way to define a dashboard that skips the checks.
    for (const request of [
      "collected cash",
      "orders by team",
      "المحصّل والمفوتر والمستحق",
      "conversion rate and won deals chart",
      "invoiced by company table",
    ]) {
      const result = suggest(request);
      const validation = validateDashboard(result.definition, input);
      expect(validation.issues, request).toEqual([]);
    }
  });

  it("never emits a metric the product does not know", () => {
    const result = suggest("collected cash and new leads and orders");
    for (const widget of result.definition.widgets) {
      for (const key of widget.metricKeys) expect(known.has(key)).toBe(true);
    }
  });
});
