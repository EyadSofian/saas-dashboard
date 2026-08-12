// Incremental sync: watermarks and tombstones.
//
// A full re-read of every model on every cycle does not scale past a small
// customer, and it makes a 15-minute freshness target impossible. Incremental
// sync reads only what changed — which introduces two problems this module
// exists to solve.
//
// 1. Where did we stop? A plain timestamp watermark loses rows: Odoo writes
//    many records in the same second during an import, and `write_date > last`
//    skips the rest of that second while `>=` re-reads it forever. The
//    watermark is therefore the composite (write_date, id).
//
// 2. What disappeared? An incremental read can only ever add. A record that was
//    deleted, unposted, or that stopped matching an approved domain would live
//    forever in the canonical layer. Reconciliation finds those and tombstones
//    them.
import { withWorkspace } from "../db/pool";
import type { WorkspaceContext } from "../contracts";
import type { ExtractionPlan } from "./plan";

export interface Watermark {
  entity: string;
  lastWriteDate: string | null;
  lastSourceId: number | null;
  lastFullSyncAt: string | null;
}

export async function readWatermarks(context: WorkspaceContext): Promise<Map<string, Watermark>> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT entity, last_write_date, last_source_id, last_full_sync_at
         FROM sync_watermarks WHERE workspace_id = $1`,
      [context.workspaceId],
    );
    return new Map(
      rows.map((row) => [
        String(row.entity),
        {
          entity: String(row.entity),
          lastWriteDate: row.last_write_date
            ? new Date(String(row.last_write_date)).toISOString()
            : null,
          lastSourceId: row.last_source_id === null ? null : Number(row.last_source_id),
          lastFullSyncAt: row.last_full_sync_at
            ? new Date(String(row.last_full_sync_at)).toISOString()
            : null,
        },
      ]),
    );
  });
}

/**
 * Commits a watermark.
 *
 * Called only after the rows it covers are durably written and the generation
 * published. Advancing it earlier would mean a crash between write and publish
 * skips those rows forever — the classic way an incremental pipeline silently
 * loses data.
 */
export async function commitWatermark(
  context: WorkspaceContext,
  entity: string,
  lastWriteDate: string | null,
  lastSourceId: number | null,
  fullSync: boolean,
): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query(
      `INSERT INTO sync_watermarks
         (workspace_id, entity, last_write_date, last_source_id, last_full_sync_at, updated_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN now() ELSE NULL END, now())
       ON CONFLICT (workspace_id, entity) DO UPDATE SET
         last_write_date   = EXCLUDED.last_write_date,
         last_source_id    = EXCLUDED.last_source_id,
         last_full_sync_at = COALESCE(EXCLUDED.last_full_sync_at, sync_watermarks.last_full_sync_at),
         updated_at        = now()`,
      [context.workspaceId, entity, lastWriteDate, lastSourceId, fullSync],
    );
  });
}

/**
 * A small overlap re-read on every incremental run.
 *
 * Odoo's `write_date` has second precision, and a row written in the same
 * second the previous run finished can land on either side of the boundary
 * depending on transaction commit order. Re-reading a minute costs little —
 * upserts are idempotent — and closes that window.
 */
const OVERLAP_SECONDS = 60;

export function incrementalDomain(
  plan: ExtractionPlan,
  watermark: Watermark | undefined,
): unknown[] {
  if (!watermark?.lastWriteDate) return [...plan.domain];

  const from = new Date(Date.parse(watermark.lastWriteDate) - OVERLAP_SECONDS * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  return [...plan.domain, ["write_date", ">=", from]];
}

/**
 * Whether this entity needs a full re-read rather than an incremental one.
 *
 * A periodic full pass is not optional: incremental reads cannot see a record
 * that stopped matching the domain, and drift accumulates silently otherwise.
 */
export function needsFullSync(watermark: Watermark | undefined, maxAgeHours = 24): boolean {
  if (!watermark?.lastFullSyncAt) return true;
  const age = Date.now() - Date.parse(watermark.lastFullSyncAt);
  return age > maxAgeHours * 3_600_000;
}

export interface ReconcileResult {
  entity: string;
  checked: number;
  tombstoned: number;
}

/**
 * Finds canonical rows whose source records no longer exist in Odoo.
 *
 * Compares ids only — cheap enough to run over a whole model, since
 * `search_read` on `["id"]` returns a few bytes per record. The alternative,
 * inferring deletion from absence in an incremental window, cannot distinguish
 * "deleted" from "not modified recently".
 */
export async function reconcileDeletions(
  context: WorkspaceContext,
  generationId: string,
  plan: ExtractionPlan,
  sourceIds: Set<number>,
): Promise<ReconcileResult> {
  const ALLOWED = new Set([
    "fact_lead",
    "fact_order",
    "fact_order_line",
    "fact_invoice",
    "fact_payment",
    "dim_company",
    "dim_currency",
    "dim_user",
    "dim_team",
    "dim_partner",
    "dim_product",
    "dim_stage",
  ]);
  if (!ALLOWED.has(plan.target)) throw new Error(`Unknown canonical table: ${plan.target}`);

  return withWorkspace(context, async (client) => {
    const { rows } = await client.query<{ source_id: string }>(
      `SELECT source_id FROM ${plan.target} WHERE workspace_id = $1 AND generation_id = $2`,
      [context.workspaceId, generationId],
    );

    const missing = rows
      .map((row) => Number(row.source_id))
      .filter((sourceId) => !sourceIds.has(sourceId));

    if (!missing.length) return { entity: plan.entity, checked: rows.length, tombstoned: 0 };

    // Recorded before deletion so the disappearance is auditable: "the number
    // dropped" and "these 40 records vanished from Odoo" are different answers
    // to a customer asking why.
    for (let index = 0; index < missing.length; index += 500) {
      const chunk = missing.slice(index, index + 500);
      const values: unknown[] = [];
      const tuples = chunk.map((sourceId) => {
        values.push(context.workspaceId, plan.entity, sourceId);
        return `($${values.length - 2},$${values.length - 1},$${values.length})`;
      });
      await client.query(
        `INSERT INTO sync_tombstones (workspace_id, entity, source_id)
         VALUES ${tuples.join(",")}
         ON CONFLICT (workspace_id, entity, source_id) DO UPDATE SET observed_at = now()`,
        values,
      );
      await client.query(
        `DELETE FROM ${plan.target}
          WHERE workspace_id = $1 AND generation_id = $2 AND source_id = ANY($3::bigint[])`,
        [context.workspaceId, generationId, chunk],
      );
    }

    return { entity: plan.entity, checked: rows.length, tombstoned: missing.length };
  });
}

export interface ScheduleRow {
  workspaceId: string;
  kind: string;
  intervalMinutes: number;
}

/** Schedules whose next run is due. Read as admin: it spans workspaces. */
export async function dueSchedules(
  client: import("pg").PoolClient,
  limit = 50,
): Promise<ScheduleRow[]> {
  const { rows } = await client.query(
    `SELECT workspace_id, kind, interval_minutes
       FROM workspace_schedules
      WHERE enabled AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    workspaceId: String(row.workspace_id),
    kind: String(row.kind),
    intervalMinutes: Number(row.interval_minutes),
  }));
}

export async function markScheduled(
  client: import("pg").PoolClient,
  workspaceId: string,
  kind: string,
  intervalMinutes: number,
): Promise<void> {
  // next_run_at is computed from now rather than from the previous scheduled
  // time, so a backlog after downtime does not fire a burst of catch-up runs.
  await client.query(
    `UPDATE workspace_schedules
        SET last_run_at = now(),
            next_run_at = now() + make_interval(mins => $1)
      WHERE workspace_id = $2 AND kind = $3`,
    [intervalMinutes, workspaceId, kind],
  );
}
