// Workspace-scoped repositories.
//
// Every function here takes a WorkspaceContext and runs inside withWorkspace(),
// so RLS is active for the query. A repository will not build a query without a
// context (INV-5) — that refusal is the application layer of the two-layer model
// described in ADR-0004, with RLS underneath it.
import type { PoolClient } from "pg";
import { withAdmin, withUser, withWorkspace } from "../db/pool";
import type {
  OdooConnectionPublic,
  PermissionGap,
  SchemaSnapshot,
  SnapshotPayload,
  Workspace,
  WorkspaceContext,
  Role,
} from "../contracts";
import { roleGrants } from "../contracts";
import type { StoredSecret } from "../secrets";

export class ForbiddenError extends Error {
  constructor(permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
  }
}

/** Fails closed: an unknown permission or a role that does not grant it throws. */
export function requirePermission(context: WorkspaceContext, permission: string): void {
  if (!roleGrants(context.roles, permission)) throw new ForbiddenError(permission);
}

function mapWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    slug: String(row.slug),
    timezone: String(row.timezone),
    locale: String(row.locale) as Workspace["locale"],
    baseCurrency: String(row.base_currency),
    industryPack: row.industry_pack ? String(row.industry_pack) : null,
    onboardingState: String(row.onboarding_state) as Workspace["onboardingState"],
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/**
 * The workspaces a user may enter. Runs with `app.user_id` only — the RLS policy
 * on `workspaces` exposes exactly the rows they hold a membership for.
 */
export async function listWorkspacesForUser(
  userId: string,
): Promise<Array<Workspace & { roles: Role[] }>> {
  return withUser(userId, async (client) => {
    const { rows } = await client.query(
      `SELECT w.*, m.roles
         FROM workspaces w
         JOIN memberships m ON m.workspace_id = w.id
        WHERE m.user_id = $1 AND m.deleted_at IS NULL AND w.deleted_at IS NULL
        ORDER BY w.created_at`,
      [userId],
    );
    return rows.map((row) => ({
      ...mapWorkspace(row),
      roles: (row.roles as string[]).filter(Boolean) as Role[],
    }));
  });
}

/**
 * Resolves a request's workspace context from membership.
 *
 * The workspace id arrives from the client, so it is treated as a *request*:
 * membership is what actually decides. No membership means no context, and the
 * caller turns that into a 403 (INV-5).
 */
export async function resolveWorkspaceContext(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceContext | null> {
  return withUser(userId, async (client) => {
    const { rows } = await client.query<{
      workspace_id: string;
      organization_id: string;
      roles: string[];
    }>(
      `SELECT workspace_id, organization_id, roles
         FROM memberships
        WHERE user_id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [userId, workspaceId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      workspaceId: row.workspace_id,
      organizationId: row.organization_id,
      userId,
      roles: (row.roles ?? []).filter(Boolean) as Role[],
    };
  });
}

export async function getWorkspace(context: WorkspaceContext): Promise<Workspace | null> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM workspaces WHERE id = $1 AND deleted_at IS NULL",
      [context.workspaceId],
    );
    return rows[0] ? mapWorkspace(rows[0]) : null;
  });
}

export async function setOnboardingState(
  context: WorkspaceContext,
  state: Workspace["onboardingState"],
): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query("UPDATE workspaces SET onboarding_state = $1 WHERE id = $2", [
      state,
      context.workspaceId,
    ]);
  });
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

function mapConnection(
  row: Record<string, unknown>,
  hasSecret: boolean,
  adapter: string,
): OdooConnectionPublic {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    baseUrl: String(row.base_url),
    database: String(row.database),
    login: String(row.login),
    // The only thing ever said about the credential.
    hasSecret,
    secretAdapter: adapter,
    status: String(row.status) as OdooConnectionPublic["status"],
    lastTestedAt: row.last_tested_at ? new Date(String(row.last_tested_at)).toISOString() : null,
    lastTestState: row.last_test_state ? String(row.last_test_state) : null,
    odooVersion: row.odoo_version ? String(row.odoo_version) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export async function getConnection(
  context: WorkspaceContext,
): Promise<OdooConnectionPublic | null> {
  requirePermission(context, "connection.read");
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT c.*,
              r.id IS NOT NULL AS has_secret,
              COALESCE(r.adapter_id, '') AS adapter_id
         FROM odoo_connections c
         LEFT JOIN connection_secret_refs r
                ON r.connection_id = c.id AND r.purpose = 'odoo_api_key'
        WHERE c.workspace_id = $1 AND c.deleted_at IS NULL`,
      [context.workspaceId],
    );
    const row = rows[0];
    return row ? mapConnection(row, Boolean(row.has_secret), String(row.adapter_id)) : null;
  });
}

export interface UpsertConnectionInput {
  /**
   * Chosen before encrypting the credential because the connection id is part
   * of the AES-GCM authenticated data. The exact same id must therefore be
   * persisted with the ciphertext; generating a second id here would make the
   * credential permanently undecryptable.
   */
  connectionId: string;
  baseUrl: string;
  database: string;
  login: string;
  secret: StoredSecret;
  /**
   * False when `secret` is the row's own stored ciphertext, reused unchanged by
   * a save that only edited the URL, database or login. Decides whether the
   * credential is treated as new — see the verdict handling below.
   */
  credentialReplaced: boolean;
}

/**
 * Creates or replaces the workspace's connection and its secret reference in one
 * transaction, so a connection can never exist without its credential or with a
 * stale one.
 */
export async function upsertConnection(
  context: WorkspaceContext,
  input: UpsertConnectionInput,
): Promise<OdooConnectionPublic> {
  requirePermission(context, "connection.write");
  return withWorkspace(context, async (client) => {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM odoo_connections WHERE workspace_id = $1 AND deleted_at IS NULL",
      [context.workspaceId],
    );

    let connectionId: string;
    if (existing.rows[0]) {
      connectionId = existing.rows[0].id;
      if (input.connectionId !== connectionId) {
        throw new Error("Connection identity changed while storing its credential.");
      }
      // The status already returns to 'draft' here, so the verdict beside it
      // goes too — a row reading "draft" next to `last_test_state = success` is
      // reporting a result for a connection that no longer exists. A verdict
      // describes the whole tuple: host, database, login and credential. Any
      // edit invalidates it, including one that kept the stored key, so "not
      // tested yet" is the honest answer until the test is run again.
      await client.query(
        `UPDATE odoo_connections
            SET base_url = $1, database = $2, login = $3,
                status = 'draft', last_test_state = NULL, last_tested_at = NULL,
                updated_at = now()
          WHERE id = $4 AND workspace_id = $5`,
        [input.baseUrl, input.database, input.login, connectionId, context.workspaceId],
      );
    } else {
      connectionId = input.connectionId;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO odoo_connections
           (id, workspace_id, base_url, database, login, status, created_by)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6)
         RETURNING id`,
        [
          connectionId,
          context.workspaceId,
          input.baseUrl,
          input.database,
          input.login,
          context.userId,
        ],
      );
      if (inserted.rows[0].id !== connectionId) {
        throw new Error("The stored connection id did not match its encrypted credential.");
      }
    }

    // Written on every save, including one that reuses the stored ciphertext:
    // the row is then rewritten with identical bytes, which keeps the invariant
    // that a connection and its credential are created together. Only
    // `rotated_at` distinguishes the two, so it keeps meaning "when the key last
    // changed" rather than "when the form was last submitted".
    await client.query(
      `INSERT INTO connection_secret_refs
         (workspace_id, connection_id, purpose, adapter_id, key_id, ciphertext, iv, auth_tag)
       VALUES ($1, $2, 'odoo_api_key', $3, $4, $5, $6, $7)
       ON CONFLICT (connection_id, purpose) DO UPDATE SET
         adapter_id = EXCLUDED.adapter_id,
         key_id     = EXCLUDED.key_id,
         ciphertext = EXCLUDED.ciphertext,
         iv         = EXCLUDED.iv,
         auth_tag   = EXCLUDED.auth_tag,
         rotated_at = CASE WHEN $8::boolean THEN now()
                           ELSE connection_secret_refs.rotated_at END`,
      [
        context.workspaceId,
        connectionId,
        input.secret.adapterId,
        input.secret.keyId,
        input.secret.ciphertext,
        input.secret.iv,
        input.secret.authTag,
        input.credentialReplaced,
      ],
    );

    const { rows } = await client.query(
      "SELECT * FROM odoo_connections WHERE id = $1 AND workspace_id = $2",
      [connectionId, context.workspaceId],
    );
    return mapConnection(rows[0], true, input.secret.adapterId);
  });
}

/** Server-only. The returned material is never sent to a client. */
export async function loadConnectionSecret(
  context: WorkspaceContext,
  connectionId: string,
): Promise<StoredSecret | null> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query<{
      adapter_id: string;
      key_id: string;
      ciphertext: string;
      iv: string;
      auth_tag: string;
    }>(
      `SELECT adapter_id, key_id, ciphertext, iv, auth_tag
         FROM connection_secret_refs
        WHERE workspace_id = $1 AND connection_id = $2 AND purpose = 'odoo_api_key'`,
      [context.workspaceId, connectionId],
    );
    const row = rows[0];
    return row
      ? {
          adapterId: row.adapter_id,
          keyId: row.key_id,
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.auth_tag,
        }
      : null;
  });
}

export async function recordConnectionTest(
  context: WorkspaceContext,
  connectionId: string,
  state: string,
  odooVersion: string | null,
): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query(
      `UPDATE odoo_connections
          SET status = $1, last_tested_at = now(), last_test_state = $2,
              odoo_version = COALESCE($3, odoo_version), updated_at = now()
        WHERE id = $4 AND workspace_id = $5`,
      [
        state === "success"
          ? "connected"
          : state === "access_denied"
            ? "permission_failed"
            : "failed",
        state,
        odooVersion,
        connectionId,
        context.workspaceId,
      ],
    );
  });
}

/* ------------------------------------------------------------------ */
/* Snapshots                                                           */
/* ------------------------------------------------------------------ */

function mapSnapshot(row: Record<string, unknown>): SchemaSnapshot {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    connectionId: String(row.connection_id),
    contractVersion: 1,
    odooVersion: row.odoo_version ? String(row.odoo_version) : null,
    contentHash: String(row.content_hash),
    modelCount: Number(row.model_count),
    fieldCount: Number(row.field_count),
    relationCount: Number(row.relation_count),
    permissionGaps: (row.permission_gaps as PermissionGap[]) ?? [],
    status: String(row.status) as SchemaSnapshot["status"],
    startedAt: new Date(String(row.started_at)).toISOString(),
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
  };
}

/**
 * Persists a snapshot and its payload atomically.
 *
 * Returns the existing snapshot when the content hash already exists for this
 * workspace and connection: unchanged Odoo metadata must not create a duplicate
 * (milestone acceptance E).
 */
export async function saveSnapshot(
  context: WorkspaceContext,
  input: {
    connectionId: string;
    contentHash: string;
    odooVersion: string | null;
    payload: SnapshotPayload;
    permissionGaps: PermissionGap[];
  },
): Promise<{ snapshot: SchemaSnapshot; deduplicated: boolean }> {
  return withWorkspace(context, async (client) => {
    const existing = await client.query(
      `SELECT * FROM schema_snapshots
        WHERE workspace_id = $1 AND connection_id = $2
          AND content_hash = $3 AND status = 'ready'`,
      [context.workspaceId, input.connectionId, input.contentHash],
    );
    if (existing.rows[0]) {
      return { snapshot: mapSnapshot(existing.rows[0]), deduplicated: true };
    }

    const inserted = await client.query(
      `INSERT INTO schema_snapshots
         (workspace_id, connection_id, odoo_version, content_hash,
          model_count, field_count, relation_count, permission_gaps, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'ready', now())
       RETURNING *`,
      [
        context.workspaceId,
        input.connectionId,
        input.odooVersion,
        input.contentHash,
        input.payload.models.length,
        input.payload.fields.length,
        input.payload.relations.length,
        JSON.stringify(input.permissionGaps),
      ],
    );
    const snapshot = mapSnapshot(inserted.rows[0]);

    await insertSnapshotPayload(client, context.workspaceId, snapshot.id, input);
    return { snapshot, deduplicated: false };
  });
}

async function insertSnapshotPayload(
  client: PoolClient,
  workspaceId: string,
  snapshotId: string,
  input: { payload: SnapshotPayload; permissionGaps: PermissionGap[] },
): Promise<void> {
  for (const model of input.payload.models) {
    await client.query(
      `INSERT INTO schema_models
         (workspace_id, snapshot_id, model, label, origin, accessible, field_count, record_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace_id, snapshot_id, model) DO NOTHING`,
      [
        workspaceId,
        snapshotId,
        model.model,
        model.label,
        model.origin,
        model.accessible,
        model.fieldCount,
        model.recordCount,
      ],
    );
  }

  for (const field of input.payload.fields) {
    await client.query(
      `INSERT INTO schema_fields
         (workspace_id, snapshot_id, model, name, label, help, type, relation, relation_field,
          required, readonly, stored, computed, is_custom, selection_values)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
       ON CONFLICT (workspace_id, snapshot_id, model, name) DO NOTHING`,
      [
        workspaceId,
        snapshotId,
        field.model,
        field.name,
        field.label,
        field.help,
        field.type,
        field.relation,
        field.relationField,
        field.required,
        field.readonly,
        field.stored,
        field.computed,
        field.isCustom,
        field.selectionValues ? JSON.stringify(field.selectionValues) : null,
      ],
    );
  }

  for (const relation of input.payload.relations) {
    await client.query(
      `INSERT INTO schema_relations
         (workspace_id, snapshot_id, from_model, from_field, to_model, kind)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (workspace_id, snapshot_id, from_model, from_field, to_model) DO NOTHING`,
      [
        workspaceId,
        snapshotId,
        relation.fromModel,
        relation.fromField,
        relation.toModel,
        relation.kind,
      ],
    );
  }

  for (const gap of input.permissionGaps) {
    await client.query(
      `INSERT INTO permission_gaps
         (workspace_id, snapshot_id, model, operation, reason, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [workspaceId, snapshotId, gap.model, gap.operation, gap.reason, gap.detail],
    );
  }
}

/** The most recent ready snapshot — the last-good one served during a failure. */
export async function latestSnapshot(context: WorkspaceContext): Promise<SchemaSnapshot | null> {
  requirePermission(context, "snapshot.read");
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM schema_snapshots
        WHERE workspace_id = $1 AND status = 'ready'
        ORDER BY completed_at DESC NULLS LAST, started_at DESC
        LIMIT 1`,
      [context.workspaceId],
    );
    return rows[0] ? mapSnapshot(rows[0]) : null;
  });
}

export async function snapshotModels(
  context: WorkspaceContext,
  snapshotId: string,
): Promise<Array<Record<string, unknown>>> {
  requirePermission(context, "snapshot.read");
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT model, label, origin, accessible, field_count, record_count
         FROM schema_models
        WHERE workspace_id = $1 AND snapshot_id = $2
        ORDER BY origin, model`,
      [context.workspaceId, snapshotId],
    );
    return rows;
  });
}

export async function snapshotFields(
  context: WorkspaceContext,
  snapshotId: string,
  model: string,
): Promise<Array<Record<string, unknown>>> {
  requirePermission(context, "snapshot.read");
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT name, label, help, type, relation, required, readonly, stored,
              computed, is_custom, selection_values
         FROM schema_fields
        WHERE workspace_id = $1 AND snapshot_id = $2 AND model = $3
        ORDER BY is_custom DESC, name`,
      [context.workspaceId, snapshotId, model],
    );
    return rows;
  });
}

/* ------------------------------------------------------------------ */
/* Provisioning                                                        */
/* ------------------------------------------------------------------ */

/**
 * Creates an organization, workspace and owner membership.
 *
 * Runs as admin because it is a control-plane operation: the workspace does not
 * exist yet, so there is no context to scope it to. Ids are generated here and
 * the caller never supplies them.
 */
export async function provisionWorkspace(input: {
  userId: string;
  organizationName: string;
  workspaceName: string;
  timezone: string;
  locale: string;
  baseCurrency: string;
  industryPack?: string;
}): Promise<{ organizationId: string; workspaceId: string }> {
  const slugify = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "workspace";

  return withAdmin(async (client) => {
    const organizationId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const suffix = organizationId.slice(0, 8);

    await client.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)", [
      organizationId,
      input.organizationName,
      `${slugify(input.organizationName)}-${suffix}`,
    ]);
    await client.query(
      `INSERT INTO workspaces
         (id, organization_id, name, slug, timezone, locale, base_currency, industry_pack, onboarding_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft')`,
      [
        workspaceId,
        organizationId,
        input.workspaceName,
        slugify(input.workspaceName),
        input.timezone,
        input.locale,
        input.baseCurrency,
        input.industryPack ?? null,
      ],
    );
    await client.query(
      `INSERT INTO memberships (user_id, organization_id, workspace_id, roles)
       VALUES ($1, $2, $3, $4)`,
      [input.userId, organizationId, workspaceId, ["workspace_owner"]],
    );
    await client.query(
      "INSERT INTO onboarding_states (workspace_id, step) VALUES ($1, 'profile') ON CONFLICT DO NOTHING",
      [workspaceId],
    );
    return { organizationId, workspaceId };
  });
}
