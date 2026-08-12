// Odoo record → canonical row.
//
// Two jobs, both easy to get quietly wrong:
//
//   • Coercion. Odoo returns many2one as [id, name] and `false` for every empty
//     value, including empty strings and zero-like fields. Turning `false` into
//     0 would make "no value" indistinguishable from "zero" — the single most
//     common way an analytics product starts lying.
//
//   • Dates. A timestamp is stored in UTC *and* as a workspace-local date, so a
//     "sales in March" question is answered in the customer's calendar rather
//     than the server's.
import { withWorkspace } from "../db/pool";
import type { WorkspaceContext } from "../contracts";
import type { ExtractionPlan } from "./plan";

/** Odoo many2one arrives as [id, display_name], or false when unset. */
export function m2oId(value: unknown): number | null {
  if (Array.isArray(value) && value.length) return Number(value[0]);
  if (typeof value === "number") return value;
  return null;
}

export function m2oName(value: unknown): string | null {
  if (Array.isArray(value) && value.length > 1) return String(value[1]);
  return null;
}

/** `false` means absent in Odoo, and absent is null — never 0 and never "". */
export function odooNumber(value: unknown): number | null {
  if (value === false || value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function odooText(value: unknown): string | null {
  if (value === false || value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

export function odooBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!value.length) return null;
    return !["false", "0", "no"].includes(value.toLowerCase());
  }
  return Boolean(value);
}

/** Odoo datetimes are naive UTC strings ("2026-03-05 09:14:22"). */
export function odooTimestamp(value: unknown): string | null {
  const text = odooText(value);
  if (!text) return null;
  const iso = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function odooDate(value: unknown): string | null {
  const text = odooText(value);
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * The workspace-local calendar date of a UTC instant.
 *
 * A payment at 23:30 UTC on the 31st is the 1st in Asia/Riyadh. Reporting the
 * server's date would move revenue between months for every customer east of
 * UTC, which is most of the first market.
 */
export function localDate(utcIso: string | null, timezone: string): string | null {
  if (!utcIso) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(utcIso));
  } catch {
    return utcIso.slice(0, 10);
  }
}

export interface CanonicalRow {
  source_id: number;
  [column: string]: unknown;
}

/** Canonical concept key → the column it lands in, per target table. */
const COLUMN_MAP: Record<string, Record<string, string>> = {
  fact_lead: {
    "lead.createdAt": "created_at_utc",
    "lead.closedAt": "closed_at_utc",
    "lead.stage": "stage_id",
    "lead.team": "team_id",
    "lead.owner": "user_id",
    "lead.partner": "partner_id",
    "lead.company": "company_id",
    "lead.expectedRevenue": "expected_revenue",
    "lead.isWon": "is_won",
    "lead.isLost": "is_lost",
    "lead.lostReason": "lost_reason",
  },
  fact_order: {
    "order.reference": "reference",
    "order.orderedAt": "ordered_at_utc",
    "order.state": "state",
    "order.isConfirmed": "is_confirmed",
    "order.partner": "partner_id",
    "order.owner": "user_id",
    "order.company": "company_id",
    "order.amountTotal": "amount_total",
  },
  fact_order_line: {
    "orderLine.order": "order_id",
    "orderLine.product": "product_id",
    "orderLine.quantity": "quantity",
    "orderLine.subtotal": "subtotal",
  },
  fact_invoice: {
    "invoice.number": "number",
    "invoice.invoiceDate": "invoice_date",
    "invoice.accountingDate": "accounting_date",
    "invoice.moveType": "move_type",
    "invoice.isCreditNote": "is_credit_note",
    "invoice.isPosted": "is_posted",
    "invoice.paymentState": "payment_state",
    "invoice.amountTotal": "amount_total",
    "invoice.amountResidual": "amount_residual",
    "invoice.partner": "partner_id",
    "invoice.company": "company_id",
  },
  fact_payment: {
    "payment.date": "payment_date",
    "payment.amount": "amount",
    "payment.partner": "partner_id",
    "payment.company": "company_id",
  },
  dim_company: {},
  dim_currency: {},
  dim_user: {},
  dim_team: {},
  dim_partner: {},
  dim_product: {},
  dim_stage: {},
};

const TIMESTAMP_COLUMNS = new Set(["created_at_utc", "closed_at_utc", "ordered_at_utc"]);
const DATE_COLUMNS = new Set(["invoice_date", "accounting_date", "payment_date"]);
const REFERENCE_COLUMNS = new Set([
  "stage_id",
  "team_id",
  "user_id",
  "partner_id",
  "company_id",
  "order_id",
  "product_id",
]);
const NUMERIC_COLUMNS = new Set([
  "expected_revenue",
  "amount_total",
  "amount_residual",
  "amount",
  "quantity",
  "subtotal",
]);
const BOOLEAN_COLUMNS = new Set([
  "is_won",
  "is_lost",
  "is_confirmed",
  "is_credit_note",
  "is_posted",
]);

export function toCanonicalRow(
  plan: ExtractionPlan,
  record: Record<string, unknown>,
): CanonicalRow {
  const row: CanonicalRow = {
    source_id: Number(record.id),
    source_write_date: odooTimestamp(record.write_date),
  };

  const map = COLUMN_MAP[plan.target] ?? {};

  for (const [concept, odooField] of Object.entries(plan.columns)) {
    const column = map[concept];
    const raw = record[odooField];
    if (!column) {
      // Dimensions carry a name rather than a per-concept column.
      if (plan.target.startsWith("dim_")) row.name = odooText(raw) ?? row.name ?? "";
      continue;
    }

    if (TIMESTAMP_COLUMNS.has(column)) row[column] = odooTimestamp(raw);
    else if (DATE_COLUMNS.has(column)) row[column] = odooDate(raw);
    else if (REFERENCE_COLUMNS.has(column)) row[column] = m2oId(raw);
    else if (NUMERIC_COLUMNS.has(column)) row[column] = odooNumber(raw);
    else if (BOOLEAN_COLUMNS.has(column)) row[column] = odooBoolean(raw);
    else row[column] = odooText(raw);
  }

  // Dimensions always carry a display name, even when no concept mapped it.
  if (plan.target.startsWith("dim_") && row.name === undefined) {
    row.name = odooText(record.name) ?? "";
  }
  if (plan.target === "dim_stage") {
    row.is_won = odooBoolean(record.is_won);
  }

  // Credit notes are recognised from the move type rather than the amount sign:
  // a negative total on a normal invoice is a discount, not a refund.
  if (plan.target === "fact_invoice") {
    const moveType = odooText(record.move_type);
    if (moveType) row.is_credit_note = moveType === "out_refund";
  }

  return row;
}

/** Adds the workspace-local date beside each UTC timestamp. */
export function withLocalDates(row: CanonicalRow, timezone: string): CanonicalRow {
  const pairs: Array<[string, string]> = [
    ["created_at_utc", "created_date_local"],
    ["closed_at_utc", "closed_date_local"],
    ["ordered_at_utc", "ordered_date_local"],
  ];
  for (const [source, target] of pairs) {
    if (row[source] !== undefined) {
      row[target] = localDate(row[source] as string | null, timezone);
    }
  }
  return row;
}

const ALLOWED_TARGETS = new Set(Object.keys(COLUMN_MAP));

/**
 * Upserts a page into a canonical table.
 *
 * The conflict target is (workspace_id, generation_id, source_id), so replaying
 * a page — after a retry, or a resumed run — updates rather than duplicates.
 */
export async function upsertRows(
  context: WorkspaceContext,
  generationId: string,
  target: string,
  rows: CanonicalRow[],
): Promise<number> {
  if (!rows.length) return 0;
  // The table name is interpolated, so it must come from a closed set.
  if (!ALLOWED_TARGETS.has(target)) throw new Error(`Unknown canonical table: ${target}`);

  const timezone = await workspaceTimezone(context);
  const prepared = rows.map((row) => withLocalDates({ ...row }, timezone));

  const columns = [
    ...new Set(prepared.flatMap((row) => Object.keys(row).filter((key) => row[key] !== undefined))),
  ];
  const allColumns = ["workspace_id", "generation_id", ...columns];

  return withWorkspace(context, async (client) => {
    let written = 0;
    for (let index = 0; index < prepared.length; index += 200) {
      const chunk = prepared.slice(index, index + 200);
      const values: unknown[] = [];
      const tuples = chunk.map((row) => {
        const placeholders = allColumns.map((column) => {
          values.push(
            column === "workspace_id"
              ? context.workspaceId
              : column === "generation_id"
                ? generationId
                : (row[column] ?? null),
          );
          return `$${values.length}`;
        });
        return `(${placeholders.join(",")})`;
      });

      const updates = columns.map((column) => `${column} = EXCLUDED.${column}`).join(", ");
      const result = await client.query(
        `INSERT INTO ${target} (${allColumns.join(",")})
         VALUES ${tuples.join(",")}
         ON CONFLICT (workspace_id, generation_id, source_id) DO UPDATE SET ${updates}`,
        values,
      );
      written += result.rowCount ?? 0;
    }
    return written;
  });
}

const timezoneCache = new Map<string, string>();

async function workspaceTimezone(context: WorkspaceContext): Promise<string> {
  const cached = timezoneCache.get(context.workspaceId);
  if (cached) return cached;
  const timezone = await withWorkspace(context, async (client) => {
    const { rows } = await client.query<{ timezone: string }>(
      "SELECT timezone FROM workspaces WHERE id = $1",
      [context.workspaceId],
    );
    return rows[0]?.timezone ?? "UTC";
  });
  timezoneCache.set(context.workspaceId, timezone);
  return timezone;
}
