// Data health.
//
// `lastSuccessAt` and `lastAttemptAt` are separate columns because the audit
// found a defect where a failed refresh advanced the freshness timestamp, making
// a broken sync look fresh (audit §4.5). Freshness advances only on success —
// that rule is enforced here by never writing `last_success_at` on failure.
import { withWorkspace } from "../db/pool";
import type { DataHealthState, WorkspaceContext } from "../contracts";
import { safeErrorMessage } from "../audit/redact";

/** Beyond this a successful-but-old domain is reported as `stale`. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function recordAttempt(context: WorkspaceContext, domain: string): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query(
      `INSERT INTO data_health_states (workspace_id, domain, status, last_attempt_at)
       VALUES ($1, $2, 'never', now())
       ON CONFLICT (workspace_id, domain) DO UPDATE SET last_attempt_at = now()`,
      [context.workspaceId, domain],
    );
  });
}

export async function recordSuccess(
  context: WorkspaceContext,
  domain: string,
  rowCount: number | null,
): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query(
      `INSERT INTO data_health_states
         (workspace_id, domain, status, last_success_at, last_attempt_at, last_error, row_count)
       VALUES ($1, $2, 'success', now(), now(), NULL, $3)
       ON CONFLICT (workspace_id, domain) DO UPDATE SET
         status          = 'success',
         last_success_at = now(),
         last_attempt_at = now(),
         last_error      = NULL,
         row_count       = EXCLUDED.row_count`,
      [context.workspaceId, domain, rowCount],
    );
  });
}

export async function recordFailure(
  context: WorkspaceContext,
  domain: string,
  error: unknown,
): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query(
      `INSERT INTO data_health_states
         (workspace_id, domain, status, last_attempt_at, last_error)
       VALUES ($1, $2, 'failed', now(), $3)
       ON CONFLICT (workspace_id, domain) DO UPDATE SET
         status          = 'failed',
         last_attempt_at = now(),
         last_error      = EXCLUDED.last_error`,
      // last_success_at is deliberately absent: a failed attempt must never
      // advance freshness. This is the corrected form of the legacy defect.
      [context.workspaceId, domain, safeErrorMessage(error)],
    );
  });
}

export async function listHealth(context: WorkspaceContext): Promise<DataHealthState[]> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT workspace_id, domain, status, last_success_at, last_attempt_at, last_error, row_count
         FROM data_health_states
        WHERE workspace_id = $1
        ORDER BY domain`,
      [context.workspaceId],
    );
    const now = Date.now();
    return rows.map((row) => {
      const lastSuccessAt = row.last_success_at
        ? new Date(String(row.last_success_at)).toISOString()
        : null;
      let status = String(row.status) as DataHealthState["status"];
      // A success old enough to be untrustworthy is reported as stale rather
      // than continuing to claim health.
      if (
        status === "success" &&
        lastSuccessAt &&
        now - Date.parse(lastSuccessAt) > STALE_AFTER_MS
      ) {
        status = "stale";
      }
      return {
        workspaceId: String(row.workspace_id),
        domain: String(row.domain),
        status,
        lastSuccessAt,
        lastAttemptAt: row.last_attempt_at
          ? new Date(String(row.last_attempt_at)).toISOString()
          : null,
        lastError: row.last_error ? String(row.last_error) : null,
        rowCount: row.row_count === null ? null : Number(row.row_count),
      };
    });
  });
}
