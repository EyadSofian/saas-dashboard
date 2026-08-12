// Dashboard persistence: drafts, publication, versions and rollback.
//
// A published version is immutable. Editing produces a new draft version and
// publishing promotes it, so "what was on the board last quarter" stays
// answerable — and a rollback is publishing an old version rather than
// reconstructing one.
import { withWorkspace } from "../db/pool";
import { requirePermission } from "../workspace/repository";
import type { WorkspaceContext } from "../contracts";
import type { DashboardDefinition } from "./templates";
import { DASHBOARD_TEMPLATES } from "./templates";

export interface DashboardRecord {
  id: string;
  key: string;
  title: { ar: string; en: string };
  audience: string;
  status: string;
  version: number;
  isDefault: boolean;
  definition: DashboardDefinition;
  publishedAt: string | null;
  updatedAt: string;
}

function mapRow(row: Record<string, unknown>): DashboardRecord {
  return {
    id: String(row.id),
    key: String(row.key),
    title: { ar: String(row.title_ar), en: String(row.title_en) },
    audience: String(row.audience),
    status: String(row.status),
    version: Number(row.version),
    isDefault: Boolean(row.is_default),
    definition: (row.definition as DashboardDefinition) ?? { version: 1, widgets: [] },
    publishedAt: row.published_at ? new Date(String(row.published_at)).toISOString() : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function listDashboards(context: WorkspaceContext): Promise<DashboardRecord[]> {
  return withWorkspace(context, async (client) => {
    // One row per key: the highest version wins, so the list shows the current
    // state rather than every historical revision.
    const { rows } = await client.query(
      `SELECT DISTINCT ON (key) *
         FROM dashboards
        WHERE workspace_id = $1 AND status <> 'archived'
        ORDER BY key, version DESC`,
      [context.workspaceId],
    );
    return rows.map(mapRow);
  });
}

export async function getDashboard(
  context: WorkspaceContext,
  key: string,
): Promise<DashboardRecord | null> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM dashboards
        WHERE workspace_id = $1 AND key = $2
        ORDER BY version DESC LIMIT 1`,
      [context.workspaceId, key],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  });
}

/**
 * Seeds the starter dashboards.
 *
 * Idempotent: a workspace that already has a dashboard with a template's key
 * keeps its own edits rather than having them overwritten on the next call.
 */
export async function seedTemplates(context: WorkspaceContext): Promise<number> {
  return withWorkspace(context, async (client) => {
    let created = 0;
    for (const template of DASHBOARD_TEMPLATES) {
      const existing = await client.query(
        "SELECT 1 FROM dashboards WHERE workspace_id = $1 AND key = $2 LIMIT 1",
        [context.workspaceId, template.key],
      );
      if (existing.rows.length) continue;

      await client.query(
        `INSERT INTO dashboards
           (workspace_id, key, title_ar, title_en, audience, status, version, definition,
            is_default, published_at, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,'published',1,$6::jsonb,$7, now(), $8, $8)`,
        [
          context.workspaceId,
          template.key,
          template.title.ar,
          template.title.en,
          template.audience,
          JSON.stringify(template.definition),
          template.audience === "owner",
          context.userId,
        ],
      );
      created += 1;
    }
    return created;
  });
}

export interface SaveDraftInput {
  key: string;
  title?: { ar: string; en: string };
  audience?: string;
  definition: DashboardDefinition;
}

/**
 * Saves a draft.
 *
 * A draft for a key that is already published becomes a *new* version rather
 * than editing the live one, so the published dashboard keeps rendering
 * unchanged while someone works on the next revision.
 */
export async function saveDraft(
  context: WorkspaceContext,
  input: SaveDraftInput,
): Promise<DashboardRecord> {
  requirePermission(context, "dashboard.publish");

  return withWorkspace(context, async (client) => {
    const current = await client.query(
      `SELECT * FROM dashboards WHERE workspace_id = $1 AND key = $2
        ORDER BY version DESC LIMIT 1`,
      [context.workspaceId, input.key],
    );
    const latest = current.rows[0];

    if (latest && latest.status === "draft") {
      const { rows } = await client.query(
        `UPDATE dashboards
            SET definition = $1::jsonb,
                title_ar = COALESCE($2, title_ar),
                title_en = COALESCE($3, title_en),
                updated_at = now(), updated_by = $4
          WHERE workspace_id = $5 AND id = $6
          RETURNING *`,
        [
          JSON.stringify(input.definition),
          input.title?.ar ?? null,
          input.title?.en ?? null,
          context.userId,
          context.workspaceId,
          latest.id,
        ],
      );
      return mapRow(rows[0]);
    }

    const version = latest ? Number(latest.version) + 1 : 1;
    const { rows } = await client.query(
      `INSERT INTO dashboards
         (workspace_id, key, title_ar, title_en, audience, status, version, definition, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7::jsonb,$8,$8)
       RETURNING *`,
      [
        context.workspaceId,
        input.key,
        input.title?.ar ?? latest?.title_ar ?? "لوحة جديدة",
        input.title?.en ?? latest?.title_en ?? "New dashboard",
        input.audience ?? latest?.audience ?? "manager",
        version,
        JSON.stringify(input.definition),
        context.userId,
      ],
    );
    return mapRow(rows[0]);
  });
}

/**
 * Publishes a draft.
 *
 * The previous published version is archived rather than deleted: rollback
 * needs it, and so does anyone asking what a number looked like last month.
 */
export async function publishDashboard(
  context: WorkspaceContext,
  key: string,
): Promise<DashboardRecord | null> {
  requirePermission(context, "dashboard.publish");

  return withWorkspace(context, async (client) => {
    const { rows: draftRows } = await client.query(
      `SELECT * FROM dashboards WHERE workspace_id = $1 AND key = $2 AND status = 'draft'
        ORDER BY version DESC LIMIT 1`,
      [context.workspaceId, key],
    );
    const draft = draftRows[0];
    if (!draft) return null;

    // Snapshot into the version history before anything changes state, so the
    // history is complete even if the rest of this transaction rolls back.
    await client.query(
      `INSERT INTO dashboard_versions (workspace_id, dashboard_id, version, definition, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (workspace_id, dashboard_id, version) DO NOTHING`,
      [
        context.workspaceId,
        draft.id,
        draft.version,
        JSON.stringify(draft.definition),
        context.userId,
      ],
    );

    await client.query(
      `UPDATE dashboards SET status = 'archived'
        WHERE workspace_id = $1 AND key = $2 AND status = 'published' AND id <> $3`,
      [context.workspaceId, key, draft.id],
    );

    const { rows } = await client.query(
      `UPDATE dashboards
          SET status = 'published', published_at = now(), updated_at = now(), updated_by = $1
        WHERE workspace_id = $2 AND id = $3
        RETURNING *`,
      [context.userId, context.workspaceId, draft.id],
    );
    return mapRow(rows[0]);
  });
}

export interface VersionRecord {
  version: number;
  definition: DashboardDefinition;
  createdAt: string;
}

export async function listVersions(
  context: WorkspaceContext,
  key: string,
): Promise<VersionRecord[]> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT d.version, d.definition, d.updated_at
         FROM dashboards d
        WHERE d.workspace_id = $1 AND d.key = $2
        ORDER BY d.version DESC
        LIMIT 20`,
      [context.workspaceId, key],
    );
    return rows.map((row) => ({
      version: Number(row.version),
      definition: (row.definition as DashboardDefinition) ?? { version: 1, widgets: [] },
      createdAt: new Date(String(row.updated_at)).toISOString(),
    }));
  });
}

/**
 * Rolls back to an earlier version.
 *
 * Implemented as "save that old definition as a new draft" rather than as
 * mutating history. The version numbers only ever go up, so an audit of what
 * was published when stays readable.
 */
export async function rollbackDashboard(
  context: WorkspaceContext,
  key: string,
  version: number,
): Promise<DashboardRecord | null> {
  requirePermission(context, "dashboard.publish");

  const target = await withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      "SELECT definition FROM dashboards WHERE workspace_id = $1 AND key = $2 AND version = $3",
      [context.workspaceId, key, version],
    );
    return rows[0]?.definition as DashboardDefinition | undefined;
  });
  if (!target) return null;

  await saveDraft(context, { key, definition: target });
  return publishDashboard(context, key);
}

export async function setDefaultDashboard(context: WorkspaceContext, key: string): Promise<void> {
  requirePermission(context, "dashboard.publish");

  await withWorkspace(context, async (client) => {
    // Cleared first: the partial unique index permits exactly one default, so
    // setting a new one without clearing the old would fail.
    await client.query("UPDATE dashboards SET is_default = false WHERE workspace_id = $1", [
      context.workspaceId,
    ]);
    await client.query(
      `UPDATE dashboards SET is_default = true
        WHERE workspace_id = $1 AND key = $2 AND status = 'published'`,
      [context.workspaceId, key],
    );
  });
}

/* ------------------------------------------------------------ saved views -- */

export interface SavedView {
  key: string;
  label: { ar: string; en: string };
  filters: unknown[];
  datePreset: string | null;
}

export async function listSavedViews(context: WorkspaceContext): Promise<SavedView[]> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT key, label_ar, label_en, filters, date_preset
         FROM saved_views WHERE workspace_id = $1 ORDER BY created_at`,
      [context.workspaceId],
    );
    return rows.map((row) => ({
      key: String(row.key),
      label: { ar: String(row.label_ar), en: String(row.label_en) },
      filters: (row.filters as unknown[]) ?? [],
      datePreset: row.date_preset ? String(row.date_preset) : null,
    }));
  });
}

export async function saveView(context: WorkspaceContext, view: SavedView): Promise<void> {
  await withWorkspace(context, async (client) => {
    await client.query(
      `INSERT INTO saved_views (workspace_id, key, label_ar, label_en, filters, date_preset, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (workspace_id, key) DO UPDATE SET
         label_ar = EXCLUDED.label_ar,
         label_en = EXCLUDED.label_en,
         filters = EXCLUDED.filters,
         date_preset = EXCLUDED.date_preset`,
      [
        context.workspaceId,
        view.key,
        view.label.ar,
        view.label.en,
        JSON.stringify(view.filters),
        view.datePreset,
        context.userId,
      ],
    );
  });
}
