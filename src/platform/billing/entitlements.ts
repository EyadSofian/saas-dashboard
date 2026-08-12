// Plan entitlements and usage metering.
//
// Two rules the pricing follows, both deliberate:
//
//   • Meter what costs: connected databases, rows held, sync frequency, seats,
//     AI calls.
//   • Never meter correctness. A Starter customer gets the same reconciliation,
//     the same null discipline and the same explainability as an Enterprise
//     one. Selling "accurate numbers" as an upgrade would mean shipping
//     inaccurate ones as the default, which is not a product this should be.
import { withWorkspace } from "../db/pool";
import type { WorkspaceContext } from "../contracts";

export interface Plan {
  key: string;
  label: { ar: string; en: string };
  maxConnections: number | null;
  maxMembers: number | null;
  maxDashboards: number | null;
  maxSyncedRows: number | null;
  minSyncMinutes: number;
  copilotEnabled: boolean;
  aiMappingEnabled: boolean;
  retentionDays: number;
}

export type LimitKey =
  | "connections"
  | "members"
  | "dashboards"
  | "syncedRows"
  | "syncFrequency"
  | "copilot"
  | "aiMapping";

export interface LimitCheck {
  allowed: boolean;
  limit: number | null;
  current: number;
  reason?: string;
  planKey: string;
}

export async function planFor(context: WorkspaceContext): Promise<Plan> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT p.* FROM workspace_subscriptions s
         JOIN plans p ON p.key = s.plan_key
        WHERE s.workspace_id = $1`,
      [context.workspaceId],
    );
    // A workspace with no subscription row is treated as Starter rather than
    // as unlimited: an ambiguous plan must fail closed, not open.
    const row = rows[0];
    if (!row) {
      const fallback = await client.query("SELECT * FROM plans WHERE key = 'starter'");
      return mapPlan(fallback.rows[0]);
    }
    return mapPlan(row);
  });
}

function mapPlan(row: Record<string, unknown>): Plan {
  return {
    key: String(row.key),
    label: { ar: String(row.label_ar), en: String(row.label_en) },
    maxConnections: row.max_connections === null ? null : Number(row.max_connections),
    maxMembers: row.max_members === null ? null : Number(row.max_members),
    maxDashboards: row.max_dashboards === null ? null : Number(row.max_dashboards),
    maxSyncedRows: row.max_synced_rows === null ? null : Number(row.max_synced_rows),
    minSyncMinutes: Number(row.min_sync_minutes),
    copilotEnabled: Boolean(row.copilot_enabled),
    aiMappingEnabled: Boolean(row.ai_mapping_enabled),
    retentionDays: Number(row.retention_days),
  };
}

/**
 * Checks a limit before the action that would exceed it.
 *
 * Returns a verdict rather than throwing, so the UI can disable a button and
 * explain why instead of letting someone fill in a form and be rejected at the
 * end of it.
 */
export async function checkLimit(context: WorkspaceContext, limit: LimitKey): Promise<LimitCheck> {
  const plan = await planFor(context);

  const boolean = (enabled: boolean, name: string): LimitCheck => ({
    allowed: enabled,
    limit: enabled ? null : 0,
    current: 0,
    planKey: plan.key,
    reason: enabled ? undefined : `${name} is not included in the ${plan.key} plan.`,
  });

  if (limit === "copilot") return boolean(plan.copilotEnabled, "The copilot");
  if (limit === "aiMapping") return boolean(plan.aiMappingEnabled, "AI-assisted mapping");

  const counts: Record<string, { sql: string; max: number | null }> = {
    connections: {
      sql: "SELECT count(*)::int AS n FROM odoo_connections WHERE workspace_id = $1 AND deleted_at IS NULL",
      max: plan.maxConnections,
    },
    members: {
      sql: "SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1 AND deleted_at IS NULL",
      max: plan.maxMembers,
    },
    dashboards: {
      sql: "SELECT count(DISTINCT key)::int AS n FROM dashboards WHERE workspace_id = $1 AND status <> 'archived'",
      max: plan.maxDashboards,
    },
    syncedRows: {
      sql: `SELECT COALESCE(sum((value)::int), 0)::int AS n
              FROM data_generations g,
                   LATERAL jsonb_each_text(g.row_counts)
             WHERE g.workspace_id = $1 AND g.status = 'published'`,
      max: plan.maxSyncedRows,
    },
  };

  const spec = counts[limit];
  if (!spec) {
    // An unknown limit fails closed rather than defaulting to permitted.
    return { allowed: false, limit: 0, current: 0, planKey: plan.key, reason: "Unknown limit." };
  }
  if (spec.max === null) {
    return { allowed: true, limit: null, current: 0, planKey: plan.key };
  }

  const current = await withWorkspace(context, async (client) => {
    const { rows } = await client.query<{ n: number }>(spec.sql, [context.workspaceId]);
    return Number(rows[0]?.n ?? 0);
  });

  return {
    allowed: current < spec.max,
    limit: spec.max,
    current,
    planKey: plan.key,
    reason:
      current < spec.max
        ? undefined
        : `The ${plan.key} plan allows ${spec.max}; this workspace already has ${current}.`,
  };
}

/** The fastest sync interval a plan permits. */
export async function minSyncMinutes(context: WorkspaceContext): Promise<number> {
  return (await planFor(context)).minSyncMinutes;
}

export type UsageKind =
  "sync_run" | "rows_synced" | "ai_mapping_call" | "copilot_answer" | "discovery_run" | "export";

/**
 * Records usage.
 *
 * Deliberately fire-and-forget: a metering failure must never break the action
 * being metered. Under-billing is a commercial problem; refusing a customer's
 * sync because a usage insert failed is a product one.
 */
export async function recordUsage(
  context: WorkspaceContext,
  kind: UsageKind,
  quantity = 1,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await withWorkspace(context, async (client) => {
      await client.query(
        `INSERT INTO usage_events (workspace_id, kind, quantity, metadata)
         VALUES ($1,$2,$3,$4::jsonb)`,
        [context.workspaceId, kind, quantity, JSON.stringify(metadata)],
      );
    });
  } catch {
    // Intentionally swallowed. See above.
  }
}

export interface UsageSummary {
  kind: string;
  total: number;
  events: number;
}

export async function usageSince(context: WorkspaceContext, since: Date): Promise<UsageSummary[]> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT kind, sum(quantity)::numeric AS total, count(*)::int AS events
         FROM usage_events
        WHERE workspace_id = $1 AND occurred_at >= $2
        GROUP BY kind ORDER BY kind`,
      [context.workspaceId, since.toISOString()],
    );
    return rows.map((row) => ({
      kind: String(row.kind),
      total: Number(row.total),
      events: Number(row.events),
    }));
  });
}
