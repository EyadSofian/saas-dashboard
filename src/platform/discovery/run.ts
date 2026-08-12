// Discovery orchestration: credentials → connector → discovery → snapshot.
//
// Last-good behaviour (milestone acceptance F): a failed discovery leaves the
// previous ready snapshot exactly as it was. Nothing is deleted before the new
// snapshot is complete, and the failure is recorded separately in data health.
import { getSecretStore } from "../secrets";
import { withConnector } from "../odoo/connector";
import { DISCOVERY_ALLOWLIST, RELATION_FOLLOW_ALLOWLIST } from "../odoo/allowlist";
import { discoverSchema } from "./discover";
import {
  getConnection,
  loadConnectionSecret,
  requirePermission,
  saveSnapshot,
  setOnboardingState,
} from "../workspace/repository";
import { writeAudit } from "../audit/log";
import { AUDIT_ACTIONS, type WorkspaceContext } from "../contracts";
import { recordAttempt, recordFailure, recordSuccess } from "../health";
import { withWorkspace } from "../db/pool";
import { safeErrorMessage } from "../audit/redact";

const DOMAIN = "discovery";

/** Loads and decrypts the workspace's Odoo credentials. Server-only. */
async function credentialsFor(context: WorkspaceContext) {
  const connection = await getConnection(context);
  if (!connection) throw new Error("This workspace has no Odoo connection.");

  const stored = await loadConnectionSecret(context, connection.id);
  if (!stored) throw new Error("This connection has no stored credential.");

  const apiKey = await getSecretStore().get(
    {
      workspaceId: context.workspaceId,
      connectionId: connection.id,
      purpose: "odoo_api_key",
    },
    stored,
  );

  return {
    connection,
    credentials: {
      baseUrl: connection.baseUrl,
      database: connection.database,
      login: connection.login,
      apiKey,
    },
  };
}

async function persistCheckpoint(
  context: WorkspaceContext,
  runId: string,
  state: Record<string, unknown>,
): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query(
      "UPDATE sync_runs SET checkpoint = $1::jsonb WHERE id = $2 AND workspace_id = $3",
      [JSON.stringify(state), runId, context.workspaceId],
    );
  });
}

async function openRun(context: WorkspaceContext, connectionId: string) {
  return withWorkspace(context, async (client) => {
    // A worker can die after opening the run but before finishing the job. The
    // durable job is then reclaimed; reuse its run/checkpoint instead of
    // colliding with the one-running-run uniqueness guard forever.
    const existing = await client.query<{ id: string; checkpoint: Record<string, unknown> }>(
      `SELECT id, checkpoint FROM sync_runs
        WHERE workspace_id = $1 AND kind = 'discovery' AND status = 'running'
        ORDER BY started_at DESC LIMIT 1`,
      [context.workspaceId],
    );
    if (existing.rows[0]) return existing.rows[0];

    // A partial unique index allows only one live run per workspace and kind,
    // so a double-click cannot start two concurrent scans.
    const { rows } = await client.query<{ id: string; checkpoint: Record<string, unknown> }>(
      `INSERT INTO sync_runs (workspace_id, connection_id, kind, status)
       VALUES ($1, $2, 'discovery', 'running')
       RETURNING id, checkpoint`,
      [context.workspaceId, connectionId],
    );
    return rows[0];
  });
}

async function closeRun(
  context: WorkspaceContext,
  runId: string,
  status: "succeeded" | "failed" | "interrupted",
  error?: string,
): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query(
      "UPDATE sync_runs SET status = $1, error = $2, finished_at = now() WHERE id = $3 AND workspace_id = $4",
      [status, error ?? null, runId, context.workspaceId],
    );
  });
}

/** The most recent interrupted run's checkpoint, so a retry resumes. */
async function resumePoint(context: WorkspaceContext): Promise<Record<string, unknown>> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query<{ checkpoint: Record<string, unknown> }>(
      `SELECT checkpoint FROM sync_runs
        WHERE workspace_id = $1 AND kind = 'discovery' AND status IN ('interrupted','failed')
        ORDER BY started_at DESC LIMIT 1`,
      [context.workspaceId],
    );
    return rows[0]?.checkpoint ?? {};
  });
}

export interface StartDiscoveryOptions {
  fetchImpl?: typeof fetch;
  models?: readonly string[];
}

export interface JobCallbacks {
  signal: AbortSignal;
  checkpoint: (state: Record<string, unknown>) => Promise<void>;
  heartbeat: () => Promise<void>;
}

/**
 * Enqueues a discovery scan. Returns immediately: a full scan targets under ten
 * minutes, far too long to hold a request open, and the durable queue means it
 * survives a restart mid-scan.
 */
export async function startDiscovery(context: WorkspaceContext): Promise<{ jobId: string }> {
  requirePermission(context, "discovery.run");
  // Fails here, in the request, if there is no usable connection — so the
  // customer sees the problem immediately instead of in a job that failed.
  await credentialsFor(context);

  const { enqueueJob } = await import("../jobs/durable");
  const { id } = await enqueueJob({ workspaceId: context.workspaceId, kind: "discovery" });
  // Reflect accepted work immediately. Previously the state changed only when
  // a worker claimed the job, so a queued scan could look like it never began.
  await setOnboardingState(context, "discovering");
  return { jobId: id };
}

/**
 * Enqueues a discovery run. Returns immediately with a job handle — a full scan
 * targets under 10 minutes, which is far too long for a request.
 */
/** The scan itself. Called by the job worker, never directly by a request. */
export async function runDiscovery(
  context: WorkspaceContext,
  job: JobCallbacks,
  options: StartDiscoveryOptions = {},
): Promise<void> {
  const { connection, credentials } = await credentialsFor(context);
  await setOnboardingState(context, "discovering");
  await recordAttempt(context, DOMAIN);
  await writeAudit(context, {
    action: AUDIT_ACTIONS.discoveryStarted,
    targetType: "connection",
    targetId: connection.id,
    metadata: { models: (options.models ?? DISCOVERY_ALLOWLIST).length },
  });

  const run = await openRun(context, connection.id);
  const resumeFrom = Object.keys(run.checkpoint ?? {}).length
    ? run.checkpoint
    : await resumePoint(context);

  {
    const ctx = job;
    {
      try {
        const result = await withConnector(
          credentials,
          {
            allowedModels: new Set([...DISCOVERY_ALLOWLIST, ...RELATION_FOLLOW_ALLOWLIST]),
            fetchImpl: options.fetchImpl,
            timeoutMs: 30_000,
          },
          (connector) =>
            discoverSchema(connector, {
              models: options.models,
              ctx: {
                signal: ctx.signal,
                resumeFrom,
                checkpoint: (state: Record<string, unknown>) =>
                  persistCheckpoint(context, run.id, state),
                heartbeat: ctx.heartbeat,
              },
            }),
        );

        const { snapshot, deduplicated } = await saveSnapshot(context, {
          connectionId: connection.id,
          contentHash: result.hash,
          odooVersion: result.odooVersion,
          payload: result.payload,
          permissionGaps: result.permissionGaps,
        });

        await closeRun(context, run.id, "succeeded");
        await recordSuccess(context, DOMAIN, result.payload.models.length);
        await setOnboardingState(context, "snapshot_ready");
        await writeAudit(context, {
          action: AUDIT_ACTIONS.discoveryCompleted,
          targetType: "schema_snapshot",
          targetId: snapshot.id,
          metadata: {
            contentHash: snapshot.contentHash,
            deduplicated,
            models: snapshot.modelCount,
            fields: snapshot.fieldCount,
            permissionGaps: snapshot.permissionGaps.length,
          },
        });
        return;
      } catch (error) {
        // Nothing was deleted, so the previous ready snapshot is still the one
        // the UI serves. The failure is recorded beside it, not in place of it.
        await closeRun(context, run.id, "failed", safeErrorMessage(error));
        await recordFailure(context, DOMAIN, error);
        await setOnboardingState(context, "failed");
        await writeAudit(context, {
          action: AUDIT_ACTIONS.discoveryFailed,
          targetType: "connection",
          targetId: connection.id,
          metadata: { error: safeErrorMessage(error) },
        });
        throw error;
      }
    }
  }
}
