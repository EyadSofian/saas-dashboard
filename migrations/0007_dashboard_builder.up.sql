-- 0007 · Dashboard builder: saved views and default selection.
--
-- `dashboards` and `dashboard_versions` already exist. This adds what the
-- builder needs on top: reusable filter presets, and a way to mark which
-- dashboard a workspace opens on.

ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Exactly one default per workspace, enforced by the database rather than by
-- application code that has to remember to clear the previous one.
CREATE UNIQUE INDEX IF NOT EXISTS dashboards_one_default
  ON dashboards (workspace_id) WHERE is_default AND status = 'published';

-- A named set of filters. Saved separately from the dashboard so the same view
-- ("Egypt, this quarter") applies across dashboards instead of being duplicated
-- into each one.
CREATE TABLE saved_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          text NOT NULL,
  label_ar     text NOT NULL,
  label_en     text NOT NULL,
  -- Validated against the metric engine's filter contract before it is stored;
  -- never interpolated into SQL.
  filters      jsonb NOT NULL DEFAULT '[]'::jsonb,
  date_preset  text,
  is_shared    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX saved_views_key ON saved_views (workspace_id, key);

SELECT apply_workspace_rls('saved_views'::regclass);
