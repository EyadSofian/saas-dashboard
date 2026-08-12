// The canonical concept catalog — what the product understands, independent of
// any one customer's Odoo.
//
// This is the target vocabulary that every workspace maps *into*. It is
// deliberately small: each concept has to earn its place by being needed for a
// metric, and each carries the risk level that decides whether a human must
// approve the mapping.
//
// `riskLevel: "high"` means approval is mandatory whatever the model's
// confidence. Money, lifecycle and date semantics are where a wrong mapping
// becomes a wrong board report.

export type ConceptRisk = "low" | "medium" | "high";

export type ConceptType =
  "id" | "text" | "number" | "money" | "date" | "datetime" | "boolean" | "reference" | "selection";

export interface CanonicalConcept {
  key: string;
  entity: CanonicalEntityKey;
  type: ConceptType;
  /** A missing required concept blocks publication of the metrics that need it. */
  required: boolean;
  riskLevel: ConceptRisk;
  label: { ar: string; en: string };
  /** What the concept means, phrased for a business reader, not a developer. */
  description: { ar: string; en: string };
  /** Odoo field names commonly carrying this concept — a hint, never a rule. */
  hints?: string[];
}

export const CANONICAL_ENTITIES = [
  "lead",
  "order",
  "orderLine",
  "invoice",
  "payment",
  "company",
  "currency",
  "user",
  "team",
  "partner",
  "product",
  "stage",
] as const;

export type CanonicalEntityKey = (typeof CANONICAL_ENTITIES)[number];

export interface CanonicalEntity {
  key: CanonicalEntityKey;
  /** The grain of one row. The metric planner uses this to refuse fan-out. */
  grain: "document" | "line" | "dimension";
  required: boolean;
  label: { ar: string; en: string };
  /** Odoo models commonly carrying this entity — a hint for ranking, not a rule. */
  hints: string[];
}

export const CANONICAL_ENTITY_LIST: CanonicalEntity[] = [
  {
    key: "lead",
    grain: "document",
    required: false,
    label: { ar: "الفرصة / العميل المحتمل", en: "Lead / opportunity" },
    hints: ["crm.lead"],
  },
  {
    key: "order",
    grain: "document",
    required: false,
    label: { ar: "أمر البيع", en: "Sales order" },
    hints: ["sale.order"],
  },
  {
    key: "orderLine",
    grain: "line",
    required: false,
    label: { ar: "بند أمر البيع", en: "Sales order line" },
    hints: ["sale.order.line"],
  },
  {
    key: "invoice",
    grain: "document",
    required: false,
    label: { ar: "الفاتورة", en: "Invoice" },
    hints: ["account.move"],
  },
  {
    key: "payment",
    grain: "document",
    required: false,
    label: { ar: "الدفعة", en: "Payment" },
    hints: ["account.payment"],
  },
  {
    key: "company",
    grain: "dimension",
    required: true,
    label: { ar: "الشركة", en: "Company" },
    hints: ["res.company"],
  },
  {
    key: "currency",
    grain: "dimension",
    required: true,
    label: { ar: "العملة", en: "Currency" },
    hints: ["res.currency"],
  },
  {
    key: "user",
    grain: "dimension",
    required: false,
    label: { ar: "المستخدم", en: "User" },
    hints: ["res.users"],
  },
  {
    key: "team",
    grain: "dimension",
    required: false,
    label: { ar: "الفريق", en: "Team" },
    hints: ["crm.team"],
  },
  {
    key: "partner",
    grain: "dimension",
    required: false,
    label: { ar: "العميل", en: "Customer" },
    hints: ["res.partner"],
  },
  {
    key: "product",
    grain: "dimension",
    required: false,
    label: { ar: "المنتج", en: "Product" },
    hints: ["product.product", "product.template"],
  },
  {
    key: "stage",
    grain: "dimension",
    required: false,
    label: { ar: "المرحلة", en: "Stage" },
    hints: ["crm.stage"],
  },
];

const concept = (
  key: string,
  entity: CanonicalEntityKey,
  type: ConceptType,
  riskLevel: ConceptRisk,
  required: boolean,
  ar: string,
  en: string,
  descAr: string,
  descEn: string,
  hints?: string[],
): CanonicalConcept => ({
  key,
  entity,
  type,
  required,
  riskLevel,
  label: { ar, en },
  description: { ar: descAr, en: descEn },
  hints,
});

export const CANONICAL_CONCEPTS: CanonicalConcept[] = [
  /* ------------------------------------------------------------- lead -- */
  concept(
    "lead.id",
    "lead",
    "id",
    "low",
    true,
    "معرّف الفرصة",
    "Lead ID",
    "المعرّف الفريد للفرصة في أودو.",
    "The unique identifier of the lead in Odoo.",
    ["id"],
  ),
  concept(
    "lead.createdAt",
    "lead",
    "datetime",
    "high",
    true,
    "تاريخ إنشاء الفرصة",
    "Lead created at",
    "التاريخ اللي الفرصة اتفتحت فيه. ده أساس قياس جودة الليدز اللي دخلت في فترة معينة.",
    "When the lead was opened. This is the basis for judging the quality of leads acquired in a period.",
    ["create_date"],
  ),
  concept(
    "lead.closedAt",
    "lead",
    "datetime",
    "high",
    false,
    "تاريخ إغلاق الفرصة",
    "Lead closed at",
    "التاريخ اللي الفرصة اتقفلت فيه (كسب أو خسارة). مختلف عن تاريخ الإنشاء، والخلط بينهم بيغيّر الأرقام.",
    "When the lead was closed, won or lost. Different from the creation date; conflating them changes the numbers.",
    ["date_closed"],
  ),
  concept(
    "lead.stage",
    "lead",
    "reference",
    "high",
    false,
    "مرحلة الفرصة",
    "Lead stage",
    "المرحلة الحالية في مسار المبيعات.",
    "The current stage in the sales pipeline.",
    ["stage_id"],
  ),
  concept(
    "lead.owner",
    "lead",
    "reference",
    "low",
    false,
    "مسؤول الفرصة",
    "Lead owner",
    "الموظف المسؤول عن الفرصة.",
    "The salesperson responsible for the lead.",
    ["user_id"],
  ),
  concept(
    "lead.team",
    "lead",
    "reference",
    "low",
    false,
    "فريق المبيعات",
    "Sales team",
    "الفريق المسؤول عن الفرصة.",
    "The team responsible for the lead.",
    ["team_id"],
  ),
  concept(
    "lead.partner",
    "lead",
    "reference",
    "low",
    false,
    "العميل",
    "Customer",
    "العميل المرتبط بالفرصة.",
    "The customer linked to the lead.",
    ["partner_id"],
  ),
  concept(
    "lead.company",
    "lead",
    "reference",
    "medium",
    false,
    "الشركة",
    "Company",
    "الشركة اللي الفرصة تتبعها في أودو متعدد الشركات.",
    "Which company the lead belongs to in a multi-company Odoo.",
    ["company_id"],
  ),
  concept(
    "lead.expectedRevenue",
    "lead",
    "money",
    "high",
    false,
    "الإيراد المتوقع",
    "Expected revenue",
    "قيمة الفرصة المتوقعة. رقم تقديري، مش إيراد فعلي.",
    "The forecast value of the lead. An estimate, not realised revenue.",
    ["expected_revenue"],
  ),
  concept(
    "lead.isWon",
    "lead",
    "boolean",
    "high",
    false,
    "تم الكسب",
    "Is won",
    "هل الفرصة اتقفلت مكسوبة؟ لازم يتحدد من مرحلة معتمدة، مش من اسم المرحلة.",
    "Whether the lead closed as won. Must come from an approved stage mapping, never from a stage name.",
    ["stage_id.is_won"],
  ),
  concept(
    "lead.isLost",
    "lead",
    "boolean",
    "high",
    false,
    "تم الخسارة",
    "Is lost",
    "هل الفرصة اتقفلت مخسورة؟",
    "Whether the lead closed as lost.",
    ["active", "lost_reason_id"],
  ),
  concept(
    "lead.lostReason",
    "lead",
    "text",
    "low",
    false,
    "سبب الخسارة",
    "Lost reason",
    "السبب المسجّل لخسارة الفرصة.",
    "The recorded reason the lead was lost.",
    ["lost_reason_id"],
  ),

  /* ------------------------------------------------------------ order -- */
  concept(
    "order.id",
    "order",
    "id",
    "low",
    true,
    "معرّف الأمر",
    "Order ID",
    "المعرّف الفريد لأمر البيع.",
    "The unique identifier of the sales order.",
    ["id"],
  ),
  concept(
    "order.reference",
    "order",
    "text",
    "low",
    false,
    "رقم الأمر",
    "Order reference",
    "الرقم اللي الفريق بيشوفه في أودو.",
    "The reference the team sees in Odoo.",
    ["name"],
  ),
  concept(
    "order.orderedAt",
    "order",
    "datetime",
    "high",
    true,
    "تاريخ الأمر",
    "Order date",
    "تاريخ أمر البيع، وأساس فلترة المبيعات بالفترة.",
    "The order date, and the basis for filtering sales by period.",
    ["date_order"],
  ),
  concept(
    "order.state",
    "order",
    "selection",
    "medium",
    false,
    "حالة الأمر",
    "Order state",
    "حالة الأمر (عرض سعر، مؤكد، ملغي).",
    "The order state: quotation, confirmed, cancelled.",
    ["state"],
  ),
  concept(
    "order.isConfirmed",
    "order",
    "boolean",
    "high",
    false,
    "أمر مؤكد",
    "Is confirmed",
    "هل الأمر اتأكد فعلاً؟ عروض الأسعار مش مبيعات.",
    "Whether the order is actually confirmed. A quotation is not a sale.",
    ["state"],
  ),
  concept(
    "order.amountTotal",
    "order",
    "money",
    "high",
    true,
    "إجمالي الأمر",
    "Order total",
    "القيمة الإجمالية لأمر البيع بعملته.",
    "The total value of the order in its own currency.",
    ["amount_total"],
  ),
  concept(
    "order.partner",
    "order",
    "reference",
    "low",
    false,
    "العميل",
    "Customer",
    "العميل صاحب الأمر.",
    "The customer on the order.",
    ["partner_id"],
  ),
  concept(
    "order.owner",
    "order",
    "reference",
    "low",
    false,
    "مسؤول البيع",
    "Salesperson",
    "الموظف المسؤول عن الأمر.",
    "The salesperson on the order.",
    ["user_id"],
  ),
  concept(
    "order.company",
    "order",
    "reference",
    "medium",
    false,
    "الشركة",
    "Company",
    "الشركة اللي الأمر تتبعها.",
    "The company the order belongs to.",
    ["company_id"],
  ),
  concept(
    "order.currency",
    "order",
    "reference",
    "high",
    false,
    "عملة الأمر",
    "Order currency",
    "عملة الأمر. من غيرها التحويل للعملة الأساسية مش هيبقى صح.",
    "The order currency. Without it, conversion to the base currency cannot be correct.",
    ["currency_id"],
  ),

  /* ------------------------------------------------------- order line -- */
  concept(
    "orderLine.id",
    "orderLine",
    "id",
    "low",
    true,
    "معرّف البند",
    "Line ID",
    "المعرّف الفريد للبند.",
    "The unique identifier of the line.",
    ["id"],
  ),
  concept(
    "orderLine.order",
    "orderLine",
    "reference",
    "high",
    true,
    "الأمر",
    "Order",
    "الأمر اللي البند تابع له. ضروري عشان الإجماليات ما تتضاعفش.",
    "The order the line belongs to. Required so totals do not multiply.",
    ["order_id"],
  ),
  concept(
    "orderLine.product",
    "orderLine",
    "reference",
    "low",
    false,
    "المنتج",
    "Product",
    "المنتج المباع في البند.",
    "The product sold on the line.",
    ["product_id"],
  ),
  concept(
    "orderLine.quantity",
    "orderLine",
    "number",
    "medium",
    false,
    "الكمية",
    "Quantity",
    "الكمية المباعة.",
    "The quantity sold.",
    ["product_uom_qty"],
  ),
  concept(
    "orderLine.subtotal",
    "orderLine",
    "money",
    "high",
    false,
    "إجمالي البند",
    "Line subtotal",
    "قيمة البند قبل الضريبة.",
    "The line value before tax.",
    ["price_subtotal"],
  ),

  /* ---------------------------------------------------------- invoice -- */
  concept(
    "invoice.id",
    "invoice",
    "id",
    "low",
    true,
    "معرّف الفاتورة",
    "Invoice ID",
    "المعرّف الفريد للفاتورة.",
    "The unique identifier of the invoice.",
    ["id"],
  ),
  concept(
    "invoice.number",
    "invoice",
    "text",
    "low",
    false,
    "رقم الفاتورة",
    "Invoice number",
    "رقم الفاتورة المعروض.",
    "The displayed invoice number.",
    ["name"],
  ),
  concept(
    "invoice.invoiceDate",
    "invoice",
    "date",
    "high",
    true,
    "تاريخ الفاتورة",
    "Invoice date",
    "تاريخ إصدار الفاتورة. واحد من التواريخ اللي بتحدد الإيراد.",
    "When the invoice was issued. One of the dates that can define revenue.",
    ["invoice_date"],
  ),
  concept(
    "invoice.accountingDate",
    "invoice",
    "date",
    "high",
    false,
    "التاريخ المحاسبي",
    "Accounting date",
    "تاريخ القيد المحاسبي، ممكن يختلف عن تاريخ الفاتورة.",
    "The accounting entry date, which can differ from the invoice date.",
    ["date"],
  ),
  concept(
    "invoice.moveType",
    "invoice",
    "selection",
    "high",
    false,
    "نوع القيد",
    "Move type",
    "فاتورة عميل، إشعار دائن، فاتورة مورد… التفرقة بينهم بتغيّر إشارة الرقم.",
    "Customer invoice, credit note, vendor bill. The distinction changes the sign of the number.",
    ["move_type"],
  ),
  concept(
    "invoice.isCreditNote",
    "invoice",
    "boolean",
    "high",
    false,
    "إشعار دائن",
    "Is credit note",
    "هل ده إشعار دائن (مرتجع)؟ لازم يقلل الإيراد، والسؤال هو في أي شهر.",
    "Whether this is a credit note. It must reduce revenue; the question is in which month.",
    ["move_type"],
  ),
  concept(
    "invoice.isPosted",
    "invoice",
    "boolean",
    "high",
    false,
    "مرحّلة",
    "Is posted",
    "الفواتير المسودة مش إيراد.",
    "Draft invoices are not revenue.",
    ["state"],
  ),
  concept(
    "invoice.paymentState",
    "invoice",
    "selection",
    "high",
    false,
    "حالة السداد",
    "Payment state",
    "مدفوعة، جزئية، غير مدفوعة.",
    "Paid, partially paid, or unpaid.",
    ["payment_state"],
  ),
  concept(
    "invoice.amountTotal",
    "invoice",
    "money",
    "high",
    true,
    "إجمالي الفاتورة",
    "Invoice total",
    "إجمالي الفاتورة بعملتها.",
    "The invoice total in its own currency.",
    ["amount_total"],
  ),
  concept(
    "invoice.amountResidual",
    "invoice",
    "money",
    "high",
    false,
    "المتبقي",
    "Amount due",
    "المبلغ اللي لسه متحصّلش.",
    "The amount still outstanding.",
    ["amount_residual"],
  ),
  concept(
    "invoice.partner",
    "invoice",
    "reference",
    "low",
    false,
    "العميل",
    "Customer",
    "العميل صاحب الفاتورة.",
    "The customer on the invoice.",
    ["partner_id"],
  ),
  concept(
    "invoice.company",
    "invoice",
    "reference",
    "medium",
    false,
    "الشركة",
    "Company",
    "الشركة المصدرة للفاتورة.",
    "The company that issued the invoice.",
    ["company_id"],
  ),
  concept(
    "invoice.currency",
    "invoice",
    "reference",
    "high",
    false,
    "عملة الفاتورة",
    "Invoice currency",
    "عملة الفاتورة.",
    "The invoice currency.",
    ["currency_id"],
  ),

  /* ---------------------------------------------------------- payment -- */
  concept(
    "payment.id",
    "payment",
    "id",
    "low",
    true,
    "معرّف الدفعة",
    "Payment ID",
    "المعرّف الفريد للدفعة.",
    "The unique identifier of the payment.",
    ["id"],
  ),
  concept(
    "payment.date",
    "payment",
    "date",
    "high",
    true,
    "تاريخ الدفع",
    "Payment date",
    "تاريخ التحصيل الفعلي. ده أساس «الإيراد المحصّل».",
    "When money was actually collected. This is the basis for collected revenue.",
    ["date"],
  ),
  concept(
    "payment.amount",
    "payment",
    "money",
    "high",
    true,
    "قيمة الدفعة",
    "Payment amount",
    "المبلغ المحصّل.",
    "The amount collected.",
    ["amount"],
  ),
  concept(
    "payment.partner",
    "payment",
    "reference",
    "low",
    false,
    "العميل",
    "Customer",
    "العميل الدافع.",
    "The paying customer.",
    ["partner_id"],
  ),
  concept(
    "payment.company",
    "payment",
    "reference",
    "medium",
    false,
    "الشركة",
    "Company",
    "الشركة المستلمة.",
    "The receiving company.",
    ["company_id"],
  ),
  concept(
    "payment.currency",
    "payment",
    "reference",
    "high",
    false,
    "عملة الدفعة",
    "Payment currency",
    "عملة الدفعة.",
    "The payment currency.",
    ["currency_id"],
  ),
];

export const CONCEPTS_BY_KEY = new Map(CANONICAL_CONCEPTS.map((c) => [c.key, c]));

export function conceptsForEntity(entity: CanonicalEntityKey): CanonicalConcept[] {
  return CANONICAL_CONCEPTS.filter((c) => c.entity === entity);
}

/**
 * Whether a concept always needs a human, regardless of model confidence.
 *
 * High risk means money, lifecycle or date semantics. Getting one of these
 * wrong does not produce an obviously broken dashboard — it produces a
 * confident, wrong number, which is worse.
 */
export function alwaysRequiresApproval(conceptKey: string): boolean {
  return CONCEPTS_BY_KEY.get(conceptKey)?.riskLevel === "high";
}

/**
 * The reporting policies a customer must decide, because no amount of metadata
 * inspection can answer them. These are business choices, not schema facts.
 */
export interface PolicyDefinition {
  key: string;
  question: { ar: string; en: string };
  options: Array<{ value: string; label: { ar: string; en: string } }>;
  defaultValue: string;
}

export const REPORTING_POLICIES: PolicyDefinition[] = [
  {
    key: "revenueRecognition",
    question: {
      ar: "أي تاريخ يحدد الإيراد؟",
      en: "Which date defines revenue?",
    },
    options: [
      {
        value: "payment_date",
        label: {
          ar: "تاريخ التحصيل (فلوس دخلت فعلاً)",
          en: "Payment date (cash actually received)",
        },
      },
      {
        value: "invoice_date",
        label: { ar: "تاريخ الفاتورة (تم البيع)", en: "Invoice date (the sale happened)" },
      },
      {
        value: "accounting_date",
        label: { ar: "التاريخ المحاسبي", en: "Accounting date" },
      },
    ],
    defaultValue: "invoice_date",
  },
  {
    key: "creditNoteRecognition",
    question: {
      ar: "المرتجع يقلّل إيراد أي شهر؟",
      en: "A refund reduces revenue in which month?",
    },
    options: [
      {
        value: "refund_month",
        label: { ar: "شهر المرتجع نفسه", en: "The month of the refund itself" },
      },
      {
        value: "original_month",
        label: { ar: "شهر الفاتورة الأصلية", en: "The month of the original invoice" },
      },
    ],
    defaultValue: "refund_month",
  },
  {
    key: "currencyConversion",
    question: {
      ar: "إزاي نحوّل العملات للعملة الأساسية؟",
      en: "How should currencies convert to the base currency?",
    },
    options: [
      {
        value: "transaction_date",
        label: { ar: "بسعر يوم المعاملة", en: "At the transaction-date rate" },
      },
      { value: "period_end", label: { ar: "بسعر آخر الفترة", en: "At the period-end rate" } },
    ],
    defaultValue: "transaction_date",
  },
  {
    key: "orderCounting",
    question: {
      ar: "إيه اللي يتحسب «مبيعات»؟",
      en: "What counts as a sale?",
    },
    options: [
      {
        value: "confirmed_only",
        label: { ar: "الأوامر المؤكدة فقط", en: "Confirmed orders only" },
      },
      {
        value: "include_quotations",
        label: { ar: "الأوامر وعروض الأسعار", en: "Orders and quotations" },
      },
    ],
    defaultValue: "confirmed_only",
  },
];
