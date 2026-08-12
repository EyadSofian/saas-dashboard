-- 0009 · Plans, usage metering, and workspace lifecycle.
--
-- Entitlements exist before billing does. Knowing what a workspace is allowed
-- to do is a product question; charging for it is a commercial one, and the
-- first does not need the second to be useful.

CREATE TABLE plans (
  key                 text PRIMARY KEY,
  label_ar            text NOT NULL,
  label_en            text NOT NULL,
  -- Limits. NULL means unlimited; 0 means the feature is off.
  max_connections     integer,
  max_members         integer,
  max_dashboards      integer,
  max_synced_rows     integer,
  min_sync_minutes    integer NOT NULL DEFAULT 1440,
  copilot_enabled     boolean NOT NULL DEFAULT false,
  ai_mapping_enabled  boolean NOT NULL DEFAULT false,
  retention_days      integer NOT NULL DEFAULT 365,
  sort_order          integer NOT NULL DEFAULT 0
);

-- Metering by what actually costs: connected databases, rows held, sync
-- frequency, seats and AI calls. Never by withholding data correctness — a
-- customer on the cheapest plan still gets honest numbers.
INSERT INTO plans
  (key, label_ar, label_en, max_connections, max_members, max_dashboards,
   max_synced_rows, min_sync_minutes, copilot_enabled, ai_mapping_enabled,
   retention_days, sort_order)
VALUES
  ('starter', 'المبتدئة', 'Starter', 1, 3, 5, 200000, 1440, false, false, 365, 1),
  ('growth', 'النمو', 'Growth', 3, 15, 50, 2000000, 30, true, true, 730, 2),
  ('enterprise', 'المؤسسات', 'Enterprise', NULL, NULL, NULL, NULL, 15, true, true, 2555, 3);

CREATE TABLE workspace_subscriptions (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_key     text NOT NULL REFERENCES plans(key),
  status       text NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing','active','past_due','cancelled')),
  trial_ends_at timestamptz,
  started_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Append-only. Usage is evidence for an invoice, so it is never edited.
CREATE TABLE usage_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  quantity     numeric(18,4) NOT NULL DEFAULT 1,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_workspace_idx ON usage_events (workspace_id, kind, occurred_at DESC);

-- A deletion is a scheduled, reversible-until-executed request rather than an
-- immediate DROP. A customer who asks to leave on Friday and changes their mind
-- on Monday should still have their data.
CREATE TABLE deletion_requests (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reason       text NOT NULL DEFAULT '',
  execute_after timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','cancelled','executed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  executed_at  timestamptz
);

SELECT apply_workspace_rls(t) FROM unnest(ARRAY[
  'workspace_subscriptions'::regclass, 'usage_events'::regclass, 'deletion_requests'::regclass
]) AS t;

GRANT SELECT ON plans TO insights_app;

-- Every existing workspace starts on Starter rather than on nothing: a NULL
-- plan would make every limit check ambiguous.
INSERT INTO workspace_subscriptions (workspace_id, plan_key, status)
SELECT id, 'starter', 'trialing' FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;
