// Metric packs — reusable definitions, enabled per workspace by what its
// approved mapping actually supports.
//
// Nothing here encodes one company's rules. A pack is a set of definitions that
// become available when the concepts they read were mapped and approved; a
// workspace that never mapped payments simply does not get collected revenue,
// and the UI says so rather than showing zero.
import type { MetricDefinition } from "./engine";

const metric = (definition: MetricDefinition): MetricDefinition => definition;

export const CRM_PACK: MetricDefinition[] = [
  metric({
    key: "crm.leads.new",
    label: { ar: "فرص جديدة", en: "New leads" },
    table: "fact_lead",
    grain: "document",
    aggregation: "count",
    filters: [],
    dateColumn: "created_date_local",
    unit: "count",
    fanoutPolicy: "forbid",
    allowedDimensions: ["team_id", "user_id", "company_id", "stage_id"],
    formula: {
      ar: "عدد الفرص المفتوحة، بفلترة تاريخ الإنشاء.",
      en: "Count of leads, filtered by creation date.",
    },
    version: 1,
  }),
  metric({
    key: "crm.leads.won",
    label: { ar: "فرص مكسوبة", en: "Won leads" },
    table: "fact_lead",
    grain: "document",
    aggregation: "count",
    filters: [{ column: "is_won", op: "is_true" }],
    // Won is a movement: it belongs to the period it closed in, not the period
    // the lead was created in.
    dateColumn: "closed_date_local",
    unit: "count",
    fanoutPolicy: "forbid",
    allowedDimensions: ["team_id", "user_id", "company_id"],
    formula: {
      ar: "عدد الفرص المكسوبة، بفلترة تاريخ الإغلاق.",
      en: "Count of won leads, filtered by close date.",
    },
    version: 1,
  }),
  metric({
    key: "crm.leads.lostMovement",
    label: { ar: "خسائر الفترة", en: "Lost in period" },
    table: "fact_lead",
    grain: "document",
    aggregation: "count",
    filters: [{ column: "is_lost", op: "is_true" }],
    dateColumn: "closed_date_local",
    unit: "count",
    fanoutPolicy: "forbid",
    allowedDimensions: ["team_id", "user_id", "company_id"],
    formula: {
      ar: "الفرص اللي اتقفلت خسارة داخل الفترة (بتاريخ الإغلاق).",
      en: "Leads closed as lost inside the period, by close date.",
    },
    version: 1,
  }),
  metric({
    key: "crm.leads.lostCohort",
    label: { ar: "خسائر من فرص الفترة", en: "Lost from period's leads" },
    table: "fact_lead",
    grain: "document",
    aggregation: "count",
    filters: [{ column: "is_lost", op: "is_true" }],
    // Deliberately a different metric from lostMovement, not a variant of it:
    // "how good were the leads we acquired" and "how many did we close lost"
    // are different questions, and one number cannot answer both.
    dateColumn: "created_date_local",
    unit: "count",
    fanoutPolicy: "forbid",
    allowedDimensions: ["team_id", "user_id", "company_id"],
    formula: {
      ar: "الفرص اللي دخلت في الفترة وانتهت خسارة (بتاريخ الإنشاء).",
      en: "Leads acquired in the period that ended lost, by creation date.",
    },
    version: 1,
  }),
  metric({
    key: "crm.conversionRate",
    label: { ar: "معدل التحويل", en: "Conversion rate" },
    table: "fact_lead",
    grain: "document",
    aggregation: "ratio",
    numeratorKey: "crm.leads.won",
    denominatorKey: "crm.leads.new",
    filters: [],
    dateColumn: null,
    unit: "percent",
    fanoutPolicy: "forbid",
    allowedDimensions: [],
    formula: {
      ar: "الفرص المكسوبة ÷ الفرص الجديدة. بيرجع «غير متاح» لو مفيش فرص أصلاً.",
      en: "Won leads ÷ new leads. Returns not-available when there were no leads.",
    },
    version: 1,
  }),
];

export const SALES_PACK: MetricDefinition[] = [
  metric({
    key: "sales.orders.count",
    label: { ar: "عدد الأوامر", en: "Orders" },
    table: "fact_order",
    grain: "document",
    aggregation: "count",
    filters: [],
    dateColumn: "ordered_date_local",
    unit: "count",
    fanoutPolicy: "forbid",
    allowedDimensions: ["user_id", "company_id", "partner_id"],
    formula: {
      ar: "عدد أوامر البيع داخل الفترة.",
      en: "Count of sales orders inside the period.",
    },
    version: 1,
  }),
  metric({
    key: "sales.orders.total",
    label: { ar: "قيمة الأوامر", en: "Order value" },
    table: "fact_order",
    grain: "document",
    aggregation: "sum",
    column: "amount_total",
    filters: [],
    dateColumn: "ordered_date_local",
    unit: "currency",
    fanoutPolicy: "forbid",
    allowedDimensions: ["user_id", "company_id", "partner_id"],
    formula: {
      ar: "مجموع قيم أوامر البيع. بيرجع «غير متاح» لو مفيش أوامر تحمل قيمة.",
      en: "Sum of order totals. Returns not-available when no order reports a value.",
    },
    version: 1,
  }),
  metric({
    key: "sales.averageOrderValue",
    label: { ar: "متوسط قيمة الأمر", en: "Average order value" },
    table: "fact_order",
    grain: "document",
    aggregation: "ratio",
    numeratorKey: "sales.orders.total",
    denominatorKey: "sales.orders.count",
    filters: [],
    dateColumn: null,
    unit: "currency",
    fanoutPolicy: "forbid",
    allowedDimensions: [],
    formula: {
      ar: "قيمة الأوامر ÷ عددها.",
      en: "Order value ÷ number of orders.",
    },
    version: 1,
  }),
];

export const ACCOUNTING_PACK: MetricDefinition[] = [
  metric({
    key: "accounting.invoiced",
    label: { ar: "المفوتر", en: "Invoiced" },
    table: "fact_invoice",
    grain: "document",
    aggregation: "sum",
    column: "amount_total",
    // Credit notes are excluded here and reported separately, so a reader can
    // see gross and net rather than one blended number whose sign convention
    // they have to guess.
    filters: [
      { column: "is_posted", op: "is_true" },
      { column: "is_credit_note", op: "is_false" },
    ],
    dateColumn: "invoice_date",
    unit: "currency",
    fanoutPolicy: "forbid",
    allowedDimensions: ["company_id", "partner_id"],
    formula: {
      ar: "مجموع الفواتير المرحّلة (بدون الإشعارات الدائنة)، بتاريخ الفاتورة.",
      en: "Sum of posted invoices excluding credit notes, by invoice date.",
    },
    version: 1,
  }),
  metric({
    key: "accounting.creditNotes",
    label: { ar: "الإشعارات الدائنة", en: "Credit notes" },
    table: "fact_invoice",
    grain: "document",
    aggregation: "sum",
    column: "amount_total",
    filters: [
      { column: "is_posted", op: "is_true" },
      { column: "is_credit_note", op: "is_true" },
    ],
    dateColumn: "invoice_date",
    unit: "currency",
    fanoutPolicy: "forbid",
    allowedDimensions: ["company_id", "partner_id"],
    formula: {
      ar: "مجموع الإشعارات الدائنة، بتاريخ الإشعار.",
      en: "Sum of credit notes, by the credit note's own date.",
    },
    version: 1,
  }),
  metric({
    key: "accounting.outstanding",
    label: { ar: "المستحق", en: "Outstanding" },
    table: "fact_invoice",
    grain: "document",
    aggregation: "sum",
    column: "amount_residual",
    filters: [{ column: "is_posted", op: "is_true" }],
    // Outstanding is a balance, not a flow: it is what is owed now, so it is
    // deliberately not filtered by the reporting period.
    dateColumn: null,
    unit: "currency",
    fanoutPolicy: "forbid",
    allowedDimensions: ["company_id", "partner_id"],
    formula: {
      ar: "المتبقي على الفواتير المرحّلة. رصيد حالي، مش مرتبط بالفترة المختارة.",
      en: "Residual on posted invoices. A current balance, not filtered by the selected period.",
    },
    version: 1,
  }),
  metric({
    key: "accounting.collected",
    label: { ar: "المحصّل", en: "Collected" },
    table: "fact_payment",
    grain: "document",
    aggregation: "sum",
    column: "amount",
    filters: [],
    dateColumn: "payment_date",
    unit: "currency",
    fanoutPolicy: "forbid",
    allowedDimensions: ["company_id", "partner_id"],
    formula: {
      ar: "مجموع الدفعات المحصّلة، بتاريخ الدفع.",
      en: "Sum of payments received, by payment date.",
    },
    version: 1,
  }),
];

export const ALL_PACKS: Record<string, MetricDefinition[]> = {
  crm: CRM_PACK,
  sales: SALES_PACK,
  accounting: ACCOUNTING_PACK,
};

export const ALL_METRICS: MetricDefinition[] = Object.values(ALL_PACKS).flat();

export function metricMap(): Map<string, MetricDefinition> {
  return new Map(ALL_METRICS.map((definition) => [definition.key, definition]));
}

/**
 * Which metrics a workspace can actually answer.
 *
 * A metric whose canonical table was never populated is reported as
 * unavailable rather than as zero — the difference between "you sold nothing"
 * and "we were never given your sales" matters to whoever reads it.
 */
export function availableMetrics(populatedTables: Set<string>): MetricDefinition[] {
  return ALL_METRICS.filter((definition) => {
    if (definition.aggregation === "ratio") {
      const numerator = ALL_METRICS.find((m) => m.key === definition.numeratorKey);
      const denominator = ALL_METRICS.find((m) => m.key === definition.denominatorKey);
      return Boolean(
        numerator &&
        denominator &&
        populatedTables.has(numerator.table) &&
        populatedTables.has(denominator.table),
      );
    }
    return populatedTables.has(definition.table);
  });
}
