// Natural-language dashboard suggestions.
//
// "Show me revenue and new leads this month" becomes a *draft* dashboard the
// customer then edits. It is a faster way to reach the builder, not a second
// way to define anything: the output goes through `validateDashboard` like
// every other route, so a suggestion naming a metric that does not exist is
// dropped rather than rendered as a broken widget.
//
// Deterministic matching runs first and handles most requests, in Arabic and
// English. That is not a fallback for a missing API key — it is faster, free,
// reproducible, and a keyword match against a closed metric catalog is simply
// more reliable than asking a model to pick from the same list.
import type { MetricDefinition } from "../metrics/engine";
import type { DashboardDefinition, Widget } from "./templates";

interface Intent {
  metricKeys: string[];
  dimension?: string;
  kind: Widget["kind"];
}

/**
 * Words that point at a metric, per language.
 *
 * Matching is on the request text, so both languages are checked regardless of
 * the UI language — people type "revenue" in an Arabic interface constantly.
 */
const METRIC_TERMS: Array<{ keys: string[]; terms: string[] }> = [
  {
    keys: ["accounting.collected"],
    terms: ["collected", "cash", "collection", "محصل", "محصّل", "تحصيل", "كاش", "فلوس"],
  },
  {
    keys: ["accounting.invoiced"],
    terms: [
      "invoiced",
      "invoice",
      "billing",
      "revenue",
      "مفوتر",
      "فواتير",
      "فاتورة",
      "ايراد",
      "إيراد",
    ],
  },
  {
    keys: ["accounting.outstanding"],
    terms: ["outstanding", "due", "receivable", "overdue", "مستحق", "متأخر", "مديونية"],
  },
  {
    keys: ["accounting.creditNotes"],
    terms: ["refund", "credit note", "return", "مرتجع", "اشعار دائن", "إشعار دائن"],
  },
  {
    keys: ["sales.orders.total"],
    terms: ["order value", "sales value", "sales", "قيمة الاوامر", "قيمة الأوامر", "مبيعات"],
  },
  {
    keys: ["sales.orders.count"],
    terms: ["orders", "order count", "عدد الاوامر", "عدد الأوامر", "اوامر", "أوامر"],
  },
  {
    keys: ["sales.averageOrderValue"],
    terms: ["average order", "aov", "basket", "متوسط الامر", "متوسط الأمر", "متوسط قيمة"],
  },
  {
    keys: ["crm.leads.new"],
    terms: ["leads", "new leads", "pipeline", "عملاء محتملين", "ليدز", "فرص", "فرص جديدة"],
  },
  {
    keys: ["crm.leads.won"],
    terms: ["won", "closed won", "deals won", "مكسوب", "مكسوبة", "كسب", "صفقات"],
  },
  {
    keys: ["crm.leads.lostMovement"],
    terms: ["lost", "closed lost", "خسارة", "خسائر", "مخسور"],
  },
  {
    keys: ["crm.conversionRate"],
    terms: ["conversion", "conversion rate", "معدل التحويل", "تحويل", "نسبة التحويل"],
  },
];

const DIMENSION_TERMS: Array<{ dimension: string; terms: string[] }> = [
  {
    dimension: "user_id",
    terms: [
      "by salesperson",
      "per salesperson",
      "by rep",
      "by user",
      "حسب المسؤول",
      "لكل موظف",
      "حسب الموظف",
    ],
  },
  { dimension: "team_id", terms: ["by team", "per team", "حسب الفريق", "لكل فريق"] },
  { dimension: "company_id", terms: ["by company", "per company", "حسب الشركة", "لكل شركة"] },
  { dimension: "partner_id", terms: ["by customer", "per customer", "حسب العميل", "لكل عميل"] },
];

const CHART_TERMS: Array<{ kind: Widget["kind"]; terms: string[] }> = [
  { kind: "bar", terms: ["chart", "bar", "compare", "رسم", "مقارنة", "بياني"] },
  { kind: "table", terms: ["table", "list", "breakdown", "جدول", "قائمة", "تفصيل"] },
];

/** Arabic normalisation: alef forms, taa marbuta, and the diacritics people omit. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SuggestionInput {
  request: string;
  known: Map<string, MetricDefinition>;
  available: Set<string>;
}

export interface Suggestion {
  definition: DashboardDefinition;
  matchedMetrics: string[];
  /** Metrics the words asked for that this workspace cannot answer yet. */
  unavailableMetrics: string[];
  /** True when nothing in the request matched any metric. */
  empty: boolean;
}

/**
 * Turns a request into a draft dashboard.
 *
 * A metric the workspace cannot answer is reported separately rather than
 * placed on the dashboard: the customer asked for something real, and being
 * told "you have not mapped payments yet" is more useful than a widget that
 * renders a dash forever.
 */
export function suggestDashboard(input: SuggestionInput): Suggestion {
  const text = normalize(input.request);

  const requested: string[] = [];
  for (const entry of METRIC_TERMS) {
    if (entry.terms.some((term) => text.includes(normalize(term)))) {
      for (const key of entry.keys) if (!requested.includes(key)) requested.push(key);
    }
  }

  const matched = requested.filter((key) => input.known.has(key) && input.available.has(key));
  const unavailable = requested.filter((key) => input.known.has(key) && !input.available.has(key));

  const dimension = DIMENSION_TERMS.find((entry) =>
    entry.terms.some((term) => text.includes(normalize(term))),
  )?.dimension;

  const explicitKind = CHART_TERMS.find((entry) =>
    entry.terms.some((term) => text.includes(normalize(term))),
  )?.kind;

  const intents: Intent[] = [];

  if (dimension) {
    // A breakdown is one widget per metric: two metrics grouped by salesperson
    // in one chart is two different questions sharing an axis.
    for (const key of matched) {
      const metric = input.known.get(key)!;
      const usable = metric.allowedDimensions.includes(dimension);
      intents.push({
        metricKeys: [key],
        dimension: usable ? dimension : undefined,
        kind: usable ? (explicitKind === "table" ? "table" : "bar") : "kpi",
      });
    }
  } else if (explicitKind === "bar" && matched.length > 1) {
    intents.push({ metricKeys: matched.slice(0, 6), kind: "bar" });
  } else {
    for (const key of matched) intents.push({ metricKeys: [key], kind: explicitKind ?? "kpi" });
  }

  const widgets: Widget[] = intents.map((intent, index) => {
    const metric = input.known.get(intent.metricKeys[0])!;
    return {
      id: `nl${index}-${intent.metricKeys[0].replace(/\W+/g, "-")}`,
      kind: intent.kind,
      title: { ar: metric.label.ar, en: metric.label.en },
      metricKeys: intent.metricKeys,
      ...(intent.dimension ? { dimension: intent.dimension } : {}),
      span: intent.kind === "kpi" ? 3 : 6,
    };
  });

  // Named because it is a suggestion, not a finished dashboard: the customer
  // is expected to rename, reorder and publish it themselves.
  if (unavailable.length) {
    widgets.push({
      id: "nl-unavailable",
      kind: "text",
      title: { ar: "مقاييس غير متاحة بعد", en: "Metrics not available yet" },
      metricKeys: [],
      span: 12,
      body: {
        ar: `طلبت ${unavailable.length} مقياس لسه البيانات بتاعته ما اتخرطتش أو ما اتزامنتش: ${unavailable.join("، ")}.`,
        en: `You asked for ${unavailable.length} metric(s) whose data has not been mapped or synced yet: ${unavailable.join(", ")}.`,
      },
    });
  }

  return {
    definition: { version: 1, widgets },
    matchedMetrics: matched,
    unavailableMetrics: unavailable,
    empty: matched.length === 0 && unavailable.length === 0,
  };
}
