// Server-only durable last-good storage for dashboard source datasets.
//
// Railway injects DATABASE_URL into the app service. Upstream workers post
// batches through the authenticated ingest route; they never receive direct
// database credentials. JSONB deliberately preserves the source column names
// so existing parsers can migrate away from Google Sheets without a risky
// reporting rewrite.
import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export type DashboardDataset =
  | "meta_ads"
  | "snap_ads"
  | "accounting"
  | "crm"
  | "lost"
  | "invoiced"
  | "website_sales"
  | "pbx_extensions"
  | "sla_calls";

export type DashboardRow = Record<string, string>;

export interface DatasetSnapshot {
  configured: boolean;
  dataset: DashboardDataset;
  rows: DashboardRow[];
  syncedAt: string;
  rowCount: number;
  status: "success" | "failed" | "never";
  error: string;
  metadata: Record<string, unknown>;
}

export interface DatasetWriteResult {
  dataset: DashboardDataset;
  receivedRows: number;
  rowCount: number;
  syncedAt: string;
}

const DATASETS = new Set<DashboardDataset>([
  "meta_ads",
  "snap_ads",
  "accounting",
  "crm",
  "lost",
  "invoiced",
  "website_sales",
  "pbx_extensions",
  "sla_calls",
]);

let pool: Pool | null = null;
let schemaPromise: Promise<void> | null = null;

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function isDashboardDataset(value: unknown): value is DashboardDataset {
  return typeof value === "string" && DATASETS.has(value as DashboardDataset);
}

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  if (!pool) {
    const isRailwayInternal = connectionString.includes(".railway.internal");
    pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      ssl:
        isRailwayInternal || process.env.PGSSLMODE === "disable"
          ? false
          : { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = getPool()
      .query(
        `
        CREATE TABLE IF NOT EXISTS dashboard_rows (
          dataset text NOT NULL,
          stable_key text NOT NULL,
          row_data jsonb NOT NULL,
          record_date date,
          source_updated_at timestamptz,
          synced_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (dataset, stable_key)
        );
        CREATE INDEX IF NOT EXISTS dashboard_rows_dataset_date_idx
          ON dashboard_rows (dataset, record_date);

        CREATE TABLE IF NOT EXISTS dashboard_sync_state (
          dataset text PRIMARY KEY,
          status text NOT NULL,
          row_count integer NOT NULL DEFAULT 0,
          synced_at timestamptz NOT NULL DEFAULT now(),
          error text NOT NULL DEFAULT '',
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb
        );
      `,
      )
      .then(() => undefined)
      .catch((error) => {
        schemaPromise = null;
        throw error;
      });
  }
  await schemaPromise;
}

function stringRow(row: Record<string, unknown>): DashboardRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value),
    ]),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function first(row: DashboardRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key]?.trim();
    if (value) return value;
  }
  return "";
}

function stableKey(dataset: DashboardDataset, row: DashboardRow): string {
  const explicit = first(row, [
    "__meta_key",
    "__stable_key",
    "__odoo_line_id",
    "Invoice Line ID",
    "Move Line ID",
    "__odoo_id",
    "Order ID",
    "Order ID ",
    "Sales Order #",
    "Move",
    "id",
    "ID",
    "call_id",
    "extension",
  ]);
  if (explicit) return `${dataset}:${explicit}`;
  return `${dataset}:sha256:${createHash("sha256").update(canonicalJson(row)).digest("hex")}`;
}

function recordDate(row: DashboardRow): string | null {
  const raw = first(row, [
    "Date",
    "Date ",
    "date",
    "Payment Date",
    "Order Date",
    "Creation Date",
    "Create Date",
    "__date",
    "started_at",
    "Started At",
  ]);
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const slash = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (!slash) return null;
  const month = Number(slash[1]);
  const day = Number(slash[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${slash[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function sourceUpdatedAt(row: DashboardRow): string | null {
  const raw = first(row, ["__odoo_write_date", "__source_updated_at", "updated_at"]);
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function upsertChunk(
  client: PoolClient,
  dataset: DashboardDataset,
  rows: DashboardRow[],
  syncedAt: string,
): Promise<void> {
  if (!rows.length) return;
  const values: unknown[] = [];
  const tuples = rows.map((row, index) => {
    const offset = index * 6;
    values.push(
      dataset,
      stableKey(dataset, row),
      JSON.stringify(row),
      recordDate(row),
      sourceUpdatedAt(row),
      syncedAt,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}::jsonb, $${offset + 4}::date, $${offset + 5}::timestamptz, $${offset + 6}::timestamptz)`;
  });
  await client.query(
    `INSERT INTO dashboard_rows
      (dataset, stable_key, row_data, record_date, source_updated_at, synced_at)
     VALUES ${tuples.join(",")}
     ON CONFLICT (dataset, stable_key) DO UPDATE SET
       row_data = EXCLUDED.row_data,
       record_date = EXCLUDED.record_date,
       source_updated_at = EXCLUDED.source_updated_at,
       synced_at = EXCLUDED.synced_at`,
    values,
  );
}

export async function readDashboardDataset(dataset: DashboardDataset): Promise<DatasetSnapshot> {
  if (!databaseConfigured()) {
    return {
      configured: false,
      dataset,
      rows: [],
      syncedAt: "",
      rowCount: 0,
      status: "never",
      error: "",
      metadata: {},
    };
  }
  await ensureSchema();
  const db = getPool();
  const [rowsResult, stateResult] = await Promise.all([
    db.query<{ row_data: Record<string, unknown> }>(
      `SELECT row_data
         FROM dashboard_rows
        WHERE dataset = $1
        ORDER BY record_date NULLS LAST, stable_key`,
      [dataset],
    ),
    db.query<{
      status: "success" | "failed";
      row_count: number;
      synced_at: Date;
      error: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT status, row_count, synced_at, error, metadata FROM dashboard_sync_state WHERE dataset = $1`,
      [dataset],
    ),
  ]);
  const state = stateResult.rows[0];
  return {
    configured: true,
    dataset,
    rows: rowsResult.rows.map(({ row_data }) => stringRow(row_data)),
    syncedAt: state?.synced_at ? new Date(state.synced_at).toISOString() : "",
    rowCount: state?.row_count ?? rowsResult.rowCount ?? 0,
    status: state?.status ?? "never",
    error: state?.error ?? "",
    metadata: state?.metadata ?? {},
  };
}

export async function writeDashboardDataset(
  dataset: DashboardDataset,
  inputRows: Record<string, unknown>[],
  options: {
    mode?: "upsert" | "replace";
    syncedAt?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<DatasetWriteResult> {
  await ensureSchema();
  const rows = inputRows.map(stringRow);
  const syncedAtRaw = options.syncedAt?.trim();
  const syncedAt =
    syncedAtRaw && Number.isFinite(Date.parse(syncedAtRaw))
      ? new Date(syncedAtRaw).toISOString()
      : new Date().toISOString();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (options.mode === "replace") {
      await client.query(`DELETE FROM dashboard_rows WHERE dataset = $1`, [dataset]);
    }
    for (let index = 0; index < rows.length; index += 500) {
      await upsertChunk(client, dataset, rows.slice(index, index + 500), syncedAt);
    }
    const countResult = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dashboard_rows WHERE dataset = $1`,
      [dataset],
    );
    const rowCount = Number(countResult.rows[0]?.count ?? 0);
    await client.query(
      `INSERT INTO dashboard_sync_state
         (dataset, status, row_count, synced_at, error, metadata)
       VALUES ($1, 'success', $2, $3::timestamptz, '', $4::jsonb)
       ON CONFLICT (dataset) DO UPDATE SET
         status = EXCLUDED.status,
         row_count = EXCLUDED.row_count,
         synced_at = EXCLUDED.synced_at,
         error = EXCLUDED.error,
         metadata = EXCLUDED.metadata`,
      [dataset, rowCount, syncedAt, JSON.stringify(options.metadata ?? {})],
    );
    await client.query("COMMIT");
    return { dataset, receivedRows: rows.length, rowCount, syncedAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function markDashboardDatasetFailed(
  dataset: DashboardDataset,
  message: string,
): Promise<void> {
  if (!databaseConfigured()) return;
  await ensureSchema();
  // `synced_at` is deliberately NOT updated here. It records the last
  // *successful* publish, so a failed refresh must leave it alone — otherwise
  // the dashboard reports stale rows as fresh. `status` and `error` carry the
  // failure; freshness only ever moves forward on success.
  await getPool().query(
    `INSERT INTO dashboard_sync_state (dataset, status, row_count, synced_at, error)
     VALUES ($1, 'failed', 0, now(), $2)
     ON CONFLICT (dataset) DO UPDATE SET
       status = EXCLUDED.status,
       error = EXCLUDED.error`,
    [dataset, message.slice(0, 500)],
  );
}
