// Append-only audit writer.
//
// `audit_logs` has SELECT and INSERT policies only and no UPDATE/DELETE grant,
// so with FORCE RLS an audit record cannot be altered or removed by the runtime
// role (THREAT_MODEL T9).
import { withWorkspace } from "../db/pool";
import type { AuditEvent, WorkspaceContext } from "../contracts";
import { redactSecrets } from "./redact";

// Durable jobs run as the platform rather than as a human user. Their context
// uses this sentinel UUID for permission checks, but audit_logs.actor_user_id
// is a foreign key to users and must therefore store NULL for system actions.
const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000000";

export async function writeAudit(
  context: WorkspaceContext,
  event: Pick<AuditEvent, "action" | "targetType" | "targetId" | "metadata">,
): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query(
      `INSERT INTO audit_logs (workspace_id, actor_user_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        context.workspaceId,
        context.userId === SYSTEM_ACTOR_ID ? null : context.userId,
        event.action,
        event.targetType,
        event.targetId,
        // Redacted on write, not on read: the database must never hold the
        // secret in the first place.
        JSON.stringify(redactSecrets(event.metadata ?? {})),
      ],
    );
  });
}

export async function listAudit(context: WorkspaceContext, limit = 100): Promise<AuditEvent[]> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT workspace_id, actor_user_id, action, target_type, target_id, metadata, occurred_at
         FROM audit_logs
        WHERE workspace_id = $1
        ORDER BY occurred_at DESC
        LIMIT $2`,
      [context.workspaceId, Math.min(Math.max(limit, 1), 500)],
    );
    return rows.map((row) => ({
      workspaceId: String(row.workspace_id),
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      action: String(row.action),
      targetType: String(row.target_type),
      targetId: row.target_id ? String(row.target_id) : null,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      occurredAt: new Date(String(row.occurred_at)).toISOString(),
    }));
  });
}
