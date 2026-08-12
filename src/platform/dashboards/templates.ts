// Dashboard definitions — data, not generated code.
//
// A dashboard is a list of widgets naming approved metric keys. The renderer
// interprets it; nothing is compiled, and no React file is written per customer.
// That is what makes one codebase serve every workspace.
import { z } from "zod";

export const WIDGET_KINDS = ["kpi", "bar", "line", "table", "text"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const widgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(WIDGET_KINDS),
    title: z.object({ ar: z.string().max(120), en: z.string().max(120) }).strict(),
    /** Approved metric keys. The renderer resolves these; it never sees SQL. */
    metricKeys: z.array(z.string().max(128)).max(8).default([]),
    dimension: z.string().max(64).optional(),
    /** Grid width in twelfths, so layouts stay predictable on any screen. */
    span: z.number().int().min(3).max(12).default(6),
    body: z
      .object({ ar: z.string().max(600), en: z.string().max(600) })
      .strict()
      .optional(),
  })
  .strict();

export type Widget = z.infer<typeof widgetSchema>;

export const dashboardDefinitionSchema = z
  .object({
    version: z.literal(1),
    widgets: z.array(widgetSchema).max(40),
  })
  .strict();

export type DashboardDefinition = z.infer<typeof dashboardDefinitionSchema>;

export interface DashboardTemplate {
  key: string;
  audience: "owner" | "manager" | "analyst";
  title: { ar: string; en: string };
  definition: DashboardDefinition;
}

/**
 * The starting dashboards a workspace gets.
 *
 * The owner view is deliberately short. An owner opening this on a phone needs
 * four numbers and one trend, not a table of 3,000 rows — the detail lives in
 * the manager and analyst views.
 */
export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    key: "owner-overview",
    audience: "owner",
    title: { ar: "نظرة المالك", en: "Owner overview" },
    definition: {
      version: 1,
      widgets: [
        {
          id: "kpi-collected",
          kind: "kpi",
          title: { ar: "المحصّل", en: "Collected" },
          metricKeys: ["accounting.collected"],
          span: 3,
        },
        {
          id: "kpi-invoiced",
          kind: "kpi",
          title: { ar: "المفوتر", en: "Invoiced" },
          metricKeys: ["accounting.invoiced"],
          span: 3,
        },
        {
          id: "kpi-orders",
          kind: "kpi",
          title: { ar: "قيمة الأوامر", en: "Order value" },
          metricKeys: ["sales.orders.total"],
          span: 3,
        },
        {
          id: "kpi-leads",
          kind: "kpi",
          title: { ar: "فرص جديدة", en: "New leads" },
          metricKeys: ["crm.leads.new"],
          span: 3,
        },
        {
          id: "funnel",
          kind: "bar",
          title: { ar: "مسار المبيعات", en: "Sales funnel" },
          metricKeys: ["crm.leads.new", "crm.leads.won", "crm.leads.lostMovement"],
          span: 6,
        },
        {
          id: "outstanding",
          kind: "kpi",
          title: { ar: "المستحق", en: "Outstanding" },
          metricKeys: ["accounting.outstanding"],
          span: 3,
        },
        {
          id: "conversion",
          kind: "kpi",
          title: { ar: "معدل التحويل", en: "Conversion rate" },
          metricKeys: ["crm.conversionRate"],
          span: 3,
        },
      ],
    },
  },
  {
    key: "sales-manager",
    audience: "manager",
    title: { ar: "لوحة المبيعات", en: "Sales" },
    definition: {
      version: 1,
      widgets: [
        {
          id: "orders-by-user",
          kind: "bar",
          title: { ar: "الأوامر حسب المسؤول", en: "Orders by salesperson" },
          metricKeys: ["sales.orders.total"],
          dimension: "user_id",
          span: 6,
        },
        {
          id: "aov",
          kind: "kpi",
          title: { ar: "متوسط قيمة الأمر", en: "Average order value" },
          metricKeys: ["sales.averageOrderValue"],
          span: 3,
        },
        {
          id: "order-count",
          kind: "kpi",
          title: { ar: "عدد الأوامر", en: "Orders" },
          metricKeys: ["sales.orders.count"],
          span: 3,
        },
        {
          id: "lost-note",
          kind: "text",
          title: { ar: "ملاحظة عن الخسائر", en: "A note on lost deals" },
          metricKeys: [],
          span: 12,
          body: {
            ar: "«خسائر الفترة» بتتحسب بتاريخ الإغلاق، و«خسائر من فرص الفترة» بتاريخ الإنشاء. الرقمين مختلفين وبيجاوبوا على سؤالين مختلفين.",
            en: "Lost-in-period counts by close date; lost-from-period's-leads counts by creation date. They are different numbers answering different questions.",
          },
        },
      ],
    },
  },
  {
    key: "accounting-analyst",
    audience: "analyst",
    title: { ar: "لوحة الحسابات", en: "Accounting" },
    definition: {
      version: 1,
      widgets: [
        {
          id: "invoiced-by-company",
          kind: "table",
          title: { ar: "المفوتر حسب الشركة", en: "Invoiced by company" },
          metricKeys: ["accounting.invoiced"],
          dimension: "company_id",
          span: 6,
        },
        {
          id: "credit-notes",
          kind: "kpi",
          title: { ar: "الإشعارات الدائنة", en: "Credit notes" },
          metricKeys: ["accounting.creditNotes"],
          span: 3,
        },
        {
          id: "collected-kpi",
          kind: "kpi",
          title: { ar: "المحصّل", en: "Collected" },
          metricKeys: ["accounting.collected"],
          span: 3,
        },
      ],
    },
  },
];
