// Dashboard validation.
//
// Every route into a dashboard — the builder UI, a template, natural language,
// a future API client — passes through here. One validated schema, one place
// that decides what is buildable, no second path that skips the checks.
//
// The rule that matters most: a widget may only name a metric that exists AND
// is answerable for this workspace. Without that, the builder happily produces
// a dashboard of em dashes, which looks like a broken product rather than an
// unmapped one.
import { dashboardDefinitionSchema, type DashboardDefinition, type Widget } from "./templates";
import type { MetricDefinition } from "../metrics/engine";

export interface DashboardIssue {
  widgetId: string;
  field: string;
  reason:
    | "unknown_metric"
    | "metric_unavailable"
    | "metric_required"
    | "too_many_metrics"
    | "unknown_dimension"
    | "duplicate_id"
    | "invalid_span";
  detail: string;
}

export interface DashboardValidation {
  ok: boolean;
  definition: DashboardDefinition | null;
  issues: DashboardIssue[];
}

/** How many metrics each widget kind can meaningfully render. */
const METRIC_LIMITS: Record<Widget["kind"], { min: number; max: number }> = {
  kpi: { min: 1, max: 1 },
  bar: { min: 1, max: 6 },
  line: { min: 1, max: 4 },
  table: { min: 1, max: 1 },
  text: { min: 0, max: 0 },
};

export interface ValidateInput {
  /** Every metric the product knows about. */
  known: Map<string, MetricDefinition>;
  /** The subset this workspace can actually answer, given what it synced. */
  available: Set<string>;
}

/**
 * Validates a candidate dashboard.
 *
 * Returns issues rather than throwing: the builder shows them next to the
 * offending widget, and a partially-wrong dashboard stays editable instead of
 * being rejected wholesale.
 */
export function validateDashboard(candidate: unknown, input: ValidateInput): DashboardValidation {
  const parsed = dashboardDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      definition: null,
      issues: parsed.error.issues.map((issue) => ({
        widgetId: String(issue.path[1] ?? ""),
        field: issue.path.join("."),
        reason: "invalid_span" as const,
        detail: issue.message,
      })),
    };
  }

  const definition = parsed.data;
  const issues: DashboardIssue[] = [];
  const seen = new Set<string>();

  for (const widget of definition.widgets) {
    if (seen.has(widget.id)) {
      issues.push({
        widgetId: widget.id,
        field: "id",
        reason: "duplicate_id",
        detail: `Widget id "${widget.id}" is used more than once.`,
      });
    }
    seen.add(widget.id);

    const limits = METRIC_LIMITS[widget.kind];
    if (widget.metricKeys.length < limits.min) {
      issues.push({
        widgetId: widget.id,
        field: "metricKeys",
        reason: "metric_required",
        detail: `A ${widget.kind} widget needs at least ${limits.min} metric.`,
      });
    }
    if (widget.metricKeys.length > limits.max) {
      issues.push({
        widgetId: widget.id,
        field: "metricKeys",
        reason: "too_many_metrics",
        detail: `A ${widget.kind} widget renders at most ${limits.max} metric(s).`,
      });
    }

    for (const key of widget.metricKeys) {
      const metric = input.known.get(key);
      if (!metric) {
        issues.push({
          widgetId: widget.id,
          field: "metricKeys",
          reason: "unknown_metric",
          detail: `"${key}" is not a metric in this product.`,
        });
        continue;
      }
      if (!input.available.has(key)) {
        // Known but unanswerable: the concepts behind it were never mapped or
        // never synced. Saying so is more useful than rendering a dash.
        issues.push({
          widgetId: widget.id,
          field: "metricKeys",
          reason: "metric_unavailable",
          detail: `"${key}" cannot be answered yet — the data behind it has not been mapped and synced.`,
        });
      }

      // A dimension is only meaningful if the metric declares it: grouping
      // invoices by salesperson requires the mapping to have provided one.
      if (widget.dimension && !metric.allowedDimensions.includes(widget.dimension)) {
        issues.push({
          widgetId: widget.id,
          field: "dimension",
          reason: "unknown_dimension",
          detail: `"${key}" cannot be broken down by "${widget.dimension}".`,
        });
      }
    }
  }

  return { ok: issues.length === 0, definition, issues };
}

/** A widget with sensible defaults, used when the builder adds a new one. */
export function blankWidget(kind: Widget["kind"], index: number): Widget {
  return {
    id: `w${index}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    title: { ar: "بدون عنوان", en: "Untitled" },
    metricKeys: [],
    span: kind === "kpi" ? 3 : 6,
  };
}
