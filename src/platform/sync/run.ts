// Sync: Odoo → canonical tables, published as an immutable generation.
//
// Correctness properties this file exists to guarantee:
//
//   • Keyset pagination on (write_date, id) with an upper bound captured at the
//     start, so rows written *during* the run are not half-read.
//   • Idempotent upsert on (workspace, generation, source_id): re-running
//     produces the same rows, never duplicates.
//   • A generation is built in isolation and only becomes visible by an atomic
//     pointer flip, so a reader never sees half a sync.
//   • A failed or implausibly small run never replaces healthy data.
//   • Freshness advances only on success.
import { withWorkspace } from "../db/pool";
import { withConnector, type OdooCredentials } from "../odoo/connector";
import { getSecretStore } from "../secrets";
import { getConnection, loadConnectionSecret, requirePermission } from "../workspace/repository";
import { writeAudit } from "../audit/log";
import { recordAttempt, recordFailure, recordSuccess } from "../health";
import { safeErrorMessage } from "../audit/redact";
import type { WorkspaceContext } from "../contracts";
import { currentManifest, listMappings, listPolicies } from "../semantic/repository";
import { buildExtractionPlans, type ExtractionPlan } from "./plan";
import { toCanonicalRow, upsertRows } from "./canonical";

const PAGE_SIZE = 500;

/**
 * A full extract that collapses to almost nothing is far more likely to be a
 * permission change or a bad domain than a real business event, so it is
 * refused rather than published over healthy data.
 */
const SHRINK_GUARD_RATIO = 0.5;
const SHRINK_GUARD_MIN_ROWS = 50;

export interface SyncStats {
  entity: string;
  read: number;
  written: number;
}

async function credentialsFor(context: WorkspaceContext): Promise<{
  connectionId: string;
  credentials: OdooCredentials;
}> {
  const connection = await getConnection(context);
  if (!connection) throw new Error("This workspace has no Odoo connection.");
  const stored = await loadConnectionSecret(context, connection.id);
  if (!stored) throw new Error("This connection has no stored credential.");

  const apiKey = await getSecretStore().get(
    { workspaceId: context.workspaceId, connectionId: connection.id, purpose: "odoo_api_key" },
    stored,
  );
  return {
    connectionId: connection.id,
    credentials: {
      baseUrl: connection.baseUrl,
      database: connection.database,
      login: connection.login,
      apiKey,
    },
  };
}

/**
 * Reads one model in deterministic keyset order.
 *
 * Ordering by (write_date, id) and carrying the last seen pair forward means a
 * row inserted mid-scan cannot shift a later page and cause a silent skip —
 * which is exactly what OFFSET pagination does under concurrent writes.
 */
export async function extractModel(
  connector: {
    call: <T>(m: string, method: string, a?: unknown[], k?: Record<string, unknown>) => Promise<T>;
  },
  plan: ExtractionPlan,
  upperBound: string,
  onPage: (rows: Array<Record<string, unknown>>) => Promise<void>,
  signal?: AbortSignal,
): Promise<number> {
  let lastWriteDate: string | null = null;
  let lastId = 0;
  let total = 0;

  for (;;) {
    if (signal?.aborted) break;

    const domain: unknown[] = [...plan.domain, ["write_date", "<=", upperBound]];
    if (lastWriteDate) {
      // Strictly after the last row, ordered by the same composite key.
      domain.push("|");
      domain.push(["write_date", ">", lastWriteDate]);
      domain.push("&");
      domain.push(["write_date", "=", lastWriteDate]);
      domain.push(["id", ">", lastId]);
    }

    const page = await connector.call<Array<Record<string, unknown>>>(
      plan.odooModel,
      "search_read",
      [domain, plan.fields],
      { limit: PAGE_SIZE, order: "write_date asc, id asc" },
    );

    if (!page.length) break;
    await onPage(page);
    total += page.length;

    const last = page[page.length - 1];
    lastWriteDate = String(last.write_date ?? upperBound);
    lastId = Number(last.id ?? 0);

    if (page.length < PAGE_SIZE) break;
  }

  return total;
}

export interface StartSyncOptions {
  fetchImpl?: typeof fetch;
}

export interface JobCallbacks {
  signal: AbortSignal;
  checkpoint: (state: Record<string, unknown>) => Promise<void>;
  heartbeat: () => Promise<void>;
}

/**
 * Enqueues a sync. Returns immediately: the work runs in the durable queue, so
 * it survives this request, this process and the next deploy.
 */
export async function startSync(context: WorkspaceContext): Promise<{ jobId: string }> {
  requirePermission(context, "discovery.run");

  const manifest = await currentManifest(context);
  if (!manifest || manifest.status !== "published") {
    throw new Error("Publish an approved mapping before syncing.");
  }

  const { enqueueJob } = await import("../jobs/durable");
  const { id } = await enqueueJob({ workspaceId: context.workspaceId, kind: "sync" });
  const { nudgeWorker } = await import("../jobs/handlers");
  nudgeWorker();
  return { jobId: id };
}

/** The sync itself. Called by the job worker, never directly by a request. */
export async function runSync(
  context: WorkspaceContext,
  job: JobCallbacks,
  options: StartSyncOptions = {},
): Promise<void> {
  const manifest = await currentManifest(context);
  if (!manifest || manifest.status !== "published") {
    throw new Error("Publish an approved mapping before syncing.");
  }

  const [mappings, policyRows] = await Promise.all([
    listMappings(context, manifest.id),
    listPolicies(context, manifest.id),
  ]);
  const policies = Object.fromEntries(policyRows.map((p) => [p.policyKey, p.value]));

  const entityModels = await withWorkspace(context, async (client) => {
    const { rows } = await client.query<{ canonical_entity: string; odoo_model: string }>(
      `SELECT canonical_entity, odoo_model FROM semantic_entity_mappings
        WHERE workspace_id = $1 AND manifest_id = $2 AND odoo_model <> ''`,
      [context.workspaceId, manifest.id],
    );
    return new Map(rows.map((r) => [r.canonical_entity, r.odoo_model]));
  });

  const plans = buildExtractionPlans({ mappings, entityModels, policies });
  if (!plans.length) throw new Error("No approved mappings to sync.");

  const { connectionId, credentials } = await credentialsFor(context);
  await recordAttempt(context, "sync");

  {
    const ctx = job;
    {
      const run = await withWorkspace(context, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sync_runs (workspace_id, connection_id, kind, status)
           VALUES ($1,$2,'sync','running') RETURNING id`,
          [context.workspaceId, connectionId],
        );
        return rows[0];
      });

      // The new generation is built in isolation. Nothing reads it until the
      // pointer flips, so a half-finished sync is invisible rather than wrong.
      const generation = await withWorkspace(context, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO data_generations (workspace_id, snapshot_id, manifest_id, status)
           VALUES ($1,$2,$3,'building') RETURNING id`,
          [context.workspaceId, manifest.snapshotId, manifest.id],
        );
        return rows[0].id;
      });

      const stats: SyncStats[] = [];

      try {
        // One upper bound for the whole run: every model is read as of the same
        // instant, so facts cannot disagree about which day they stopped at.
        const upperBound = new Date().toISOString().slice(0, 19).replace("T", " ");

        await withConnector(
          credentials,
          {
            allowedModels: new Set(plans.map((p) => p.odooModel)),
            fetchImpl: options.fetchImpl,
            timeoutMs: 60_000,
          },
          async (connector) => {
            for (const plan of plans) {
              if (ctx.signal.aborted) break;
              let written = 0;

              const read = await extractModel(
                connector,
                plan,
                upperBound,
                async (page) => {
                  const rows = page.map((record) => toCanonicalRow(plan, record));
                  written += await upsertRows(context, generation, plan.target, rows);
                },
                ctx.signal,
              );

              stats.push({ entity: plan.entity, read, written });
              await ctx.checkpoint({ completedEntities: stats.map((s) => s.entity) });
            }
          },
        );

        const guard = await shrinkGuard(context, generation, stats);
        if (guard) throw new Error(guard);

        // A generation publishes because it matched the source, not because the
        // extract finished. The connector is reopened for aggregate-only calls:
        // search_count and read_group cost one round trip each, so verifying a
        // million rows is far cheaper than the extract that produced them.
        const { runReconciliation } = await import("../reconciliation/run");
        const reconciliation = await withConnector(
          credentials,
          {
            allowedModels: new Set(plans.map((p) => p.odooModel)),
            fetchImpl: options.fetchImpl,
            timeoutMs: 60_000,
          },
          (connector) =>
            runReconciliation(context, {
              generationId: generation,
              plans,
              upperBound,
              connector,
            }),
        );

        if (reconciliation.verdict.status === "failed") {
          const detail = reconciliation.verdict.criticalFailures
            .map((f) => `${f.key}: source ${f.sourceValue}, ours ${f.canonicalValue}`)
            .join("; ");
          // Refused, not warned about. Publishing a revenue total that does not
          // match the ERP is the single outcome this product exists to prevent.
          throw new Error(`Reconciliation failed against Odoo — not publishing. ${detail}`);
        }

        await withWorkspace(context, async (client) => {
          await client.query(
            "UPDATE data_generations SET source_upper_bound = $1 WHERE id = $2 AND workspace_id = $3",
            [upperBound, generation, context.workspaceId],
          );
        });

        await publishGeneration(context, generation, stats);
        await withWorkspace(context, async (client) => {
          await client.query(
            "UPDATE sync_runs SET status='succeeded', finished_at=now(), stats=$1::jsonb WHERE id=$2 AND workspace_id=$3",
            [JSON.stringify(stats), run.id, context.workspaceId],
          );
        });

        const total = stats.reduce((sum, s) => sum + s.written, 0);
        await recordSuccess(context, "sync", total);
        await writeAudit(context, {
          action: "sync.published",
          targetType: "data_generation",
          targetId: generation,
          metadata: {
            stats,
            manifestVersion: manifest.version,
            reconciliation: reconciliation.verdict.status,
            warnings: reconciliation.verdict.warnings.length,
          },
        });
        return;
      } catch (error) {
        // The previous generation is still the active one: the pointer was
        // never flipped, so last-good keeps serving.
        await withWorkspace(context, async (client) => {
          await client.query(
            "UPDATE data_generations SET status='failed' WHERE id=$1 AND workspace_id=$2",
            [generation, context.workspaceId],
          );
          await client.query(
            "UPDATE sync_runs SET status='failed', error=$1, finished_at=now() WHERE id=$2 AND workspace_id=$3",
            [safeErrorMessage(error), run.id, context.workspaceId],
          );
        });
        await recordFailure(context, "sync", error);
        await writeAudit(context, {
          action: "sync.failed",
          targetType: "data_generation",
          targetId: generation,
          metadata: { error: safeErrorMessage(error) },
        });
        throw error;
      }
    }
  }
}

/**
 * Refuses to publish a generation that lost most of its rows.
 *
 * The comparison is against the currently active generation, which is the only
 * thing that would be replaced. A first sync has nothing to compare against and
 * is always allowed.
 */
async function shrinkGuard(
  context: WorkspaceContext,
  generation: string,
  stats: SyncStats[],
): Promise<string | null> {
  const total = stats.reduce((sum, s) => sum + s.written, 0);

  return withWorkspace(context, async (client) => {
    const { rows } = await client.query<{ row_counts: Record<string, number> }>(
      `SELECT g.row_counts
         FROM active_generation_pointers p
         JOIN data_generations g ON g.id = p.generation_id
        WHERE p.workspace_id = $1`,
      [context.workspaceId],
    );
    const previous = rows[0];
    if (!previous) return null;

    const previousTotal = Object.values(previous.row_counts ?? {}).reduce(
      (sum, value) => sum + Number(value ?? 0),
      0,
    );
    if (previousTotal < SHRINK_GUARD_MIN_ROWS) return null;

    if (total < previousTotal * SHRINK_GUARD_RATIO) {
      return (
        `Refusing to publish generation ${generation}: it holds ${total} rows against ` +
        `${previousTotal} previously. This is more likely a permission or domain change ` +
        `than a real drop, so the healthy data is kept.`
      );
    }
    return null;
  });
}

/** The atomic flip. One statement decides what every reader sees next. */
async function publishGeneration(
  context: WorkspaceContext,
  generation: string,
  stats: SyncStats[],
): Promise<void> {
  const counts = Object.fromEntries(stats.map((s) => [s.entity, s.written]));

  await withWorkspace(context, async (client) => {
    await client.query(
      `UPDATE data_generations
          SET status='published', published_at=now(), row_counts=$1::jsonb
        WHERE id=$2 AND workspace_id=$3`,
      [JSON.stringify(counts), generation, context.workspaceId],
    );
    await client.query(
      `INSERT INTO active_generation_pointers (workspace_id, generation_id, updated_at)
       VALUES ($1,$2,now())
       ON CONFLICT (workspace_id) DO UPDATE SET generation_id = EXCLUDED.generation_id, updated_at = now()`,
      [context.workspaceId, generation],
    );
  });
}

/** The generation every read must pin. Null means nothing is published yet. */
export async function activeGeneration(context: WorkspaceContext): Promise<string | null> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query<{ generation_id: string | null }>(
      "SELECT generation_id FROM active_generation_pointers WHERE workspace_id = $1",
      [context.workspaceId],
    );
    return rows[0]?.generation_id ?? null;
  });
}
