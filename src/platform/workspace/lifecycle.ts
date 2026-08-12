// Workspace export and deletion.
//
// A customer must be able to take their data out and to have it removed. That
// is a legal obligation in most of the markets this sells into, and it is also
// the thing that makes it safe for them to try the product at all.
//
// Deletion is scheduled rather than immediate. Someone who asks to leave on a
// Friday and changes their mind on Monday should still have their data, and an
// irreversible button that fires on the first click is a support incident
// waiting to happen.
import { withAdmin, withWorkspace } from "../db/pool";
import { requirePermission } from "./repository";
import type { WorkspaceContext } from "../contracts";

/** The grace period between requesting deletion and it becoming irreversible. */
export const DELETION_GRACE_DAYS = 7;

/**
 * Everything a workspace owns, as JSON.
 *
 * Deliberately excludes the encrypted Odoo credential. An export is a file that
 * travels by email and sits in a downloads folder; a customer's ERP key does
 * not belong in one, and they already have it — it is theirs.
 */
export async function exportWorkspace(context: WorkspaceContext): Promise<Record<string, unknown>> {
  requirePermission(context, "workspace.manage");

  return withWorkspace(context, async (client) => {
    const read = async (sql: string) => (await client.query(sql, [context.workspaceId])).rows;

    const [
      workspace,
      members,
      connections,
      snapshots,
      fields,
      manifests,
      mappings,
      policies,
      dashboards,
      health,
      audit,
      reconciliation,
    ] = await Promise.all([
      read("SELECT * FROM workspaces WHERE id = $1"),
      read(
        `SELECT m.roles, u.email, u.name, m.created_at
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1`,
      ),
      // Connection metadata without any secret reference.
      read(
        `SELECT id, base_url, database, login, status, odoo_version, created_at
           FROM odoo_connections WHERE workspace_id = $1`,
      ),
      read("SELECT * FROM schema_snapshots WHERE workspace_id = $1"),
      read("SELECT * FROM schema_fields WHERE workspace_id = $1"),
      read("SELECT * FROM semantic_manifests WHERE workspace_id = $1"),
      read("SELECT * FROM semantic_field_mappings WHERE workspace_id = $1"),
      read("SELECT * FROM reporting_policies WHERE workspace_id = $1"),
      read("SELECT * FROM dashboards WHERE workspace_id = $1"),
      read("SELECT * FROM data_health_states WHERE workspace_id = $1"),
      read("SELECT * FROM audit_logs WHERE workspace_id = $1 ORDER BY occurred_at"),
      read("SELECT * FROM reconciliation_checks WHERE workspace_id = $1"),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      format: 1,
      note: "Odoo credentials are deliberately excluded from exports.",
      workspace: workspace[0] ?? null,
      members,
      connections,
      schema: { snapshots, fields },
      semantic: { manifests, mappings, policies },
      dashboards,
      health,
      reconciliation,
      audit,
    };
  });
}

export interface DeletionRequest {
  status: string;
  executeAfter: string;
  requestedAt: string;
  reason: string;
}

export async function requestDeletion(
  context: WorkspaceContext,
  reason: string,
): Promise<DeletionRequest> {
  requirePermission(context, "workspace.manage");

  const executeAfter = new Date(Date.now() + DELETION_GRACE_DAYS * 86_400_000);

  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO deletion_requests (workspace_id, requested_by, reason, execute_after, status)
       VALUES ($1,$2,$3,$4,'scheduled')
       ON CONFLICT (workspace_id) DO UPDATE SET
         requested_by = EXCLUDED.requested_by,
         reason = EXCLUDED.reason,
         execute_after = EXCLUDED.execute_after,
         status = 'scheduled',
         requested_at = now()
       RETURNING status, execute_after, requested_at, reason`,
      [context.workspaceId, context.userId, reason.slice(0, 500), executeAfter.toISOString()],
    );
    const row = rows[0];
    return {
      status: String(row.status),
      executeAfter: new Date(String(row.execute_after)).toISOString(),
      requestedAt: new Date(String(row.requested_at)).toISOString(),
      reason: String(row.reason),
    };
  });
}

export async function cancelDeletion(context: WorkspaceContext): Promise<boolean> {
  requirePermission(context, "workspace.manage");

  return withWorkspace(context, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE deletion_requests SET status = 'cancelled'
        WHERE workspace_id = $1 AND status = 'scheduled'`,
      [context.workspaceId],
    );
    return (rowCount ?? 0) > 0;
  });
}

export async function pendingDeletion(context: WorkspaceContext): Promise<DeletionRequest | null> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT status, execute_after, requested_at, reason FROM deletion_requests
        WHERE workspace_id = $1 AND status = 'scheduled'`,
      [context.workspaceId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      status: String(row.status),
      executeAfter: new Date(String(row.execute_after)).toISOString(),
      requestedAt: new Date(String(row.requested_at)).toISOString(),
      reason: String(row.reason),
    };
  });
}

/**
 * Executes deletions whose grace period has elapsed.
 *
 * Runs as admin because it spans workspaces, and relies on `ON DELETE CASCADE`
 * from `workspaces` so nothing has to enumerate the tables — a list that would
 * silently go stale the next time a migration adds one.
 */
export async function executeDueDeletions(): Promise<string[]> {
  return withAdmin(async (client) => {
    const { rows } = await client.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM deletion_requests
        WHERE status = 'scheduled' AND execute_after <= now()`,
    );

    const deleted: string[] = [];
    for (const row of rows) {
      await client.query(
        "UPDATE deletion_requests SET status='executed', executed_at=now() WHERE workspace_id=$1",
        [row.workspace_id],
      );
      await client.query("DELETE FROM workspaces WHERE id = $1", [row.workspace_id]);
      deleted.push(row.workspace_id);
    }
    return deleted;
  });
}

/**
 * Drops data generations past the plan's retention window.
 *
 * The active generation is never dropped, whatever the retention setting says:
 * enforcing retention by blanking a customer's current dashboard would be a
 * bug wearing a policy's clothes.
 */
export async function applyRetention(
  context: WorkspaceContext,
  retentionDays: number,
): Promise<number> {
  return withWorkspace(context, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM data_generations
        WHERE workspace_id = $1
          AND created_at < now() - make_interval(days => $2)
          AND id <> COALESCE(
            (SELECT generation_id FROM active_generation_pointers WHERE workspace_id = $1),
            '00000000-0000-0000-0000-000000000000'::uuid
          )`,
      [context.workspaceId, retentionDays],
    );
    return rowCount ?? 0;
  });
}
