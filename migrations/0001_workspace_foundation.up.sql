-- 0001 · Workspace foundation
--
-- Additive only. No existing table is read, altered or dropped by this
-- migration, so the down path is total. See ADR-0004 for the isolation model.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Runtime role
--
-- The application connects as `insights_app`, which is NOT the table owner and
-- is created NOBYPASSRLS. Migrations run as the connecting (admin) role. This
-- separation is what makes FORCE ROW LEVEL SECURITY meaningful: without it, a
-- table owner silently bypasses every policy.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'insights_app') THEN
    CREATE ROLE insights_app NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE insights_app NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Identity (Better Auth owns these shapes — ADR-0001)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL DEFAULT '',
  email_verified boolean NOT NULL DEFAULT false,
  image         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id              text NOT NULL,
  provider_id             text NOT NULL,
  access_token            text,
  refresh_token           text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope                   text,
  id_token                text,
  password                text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_key ON accounts (provider_id, account_id);
CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS verifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verifications_identifier_idx ON verifications (identifier);

-- ---------------------------------------------------------------------------
-- Organizations and workspaces
--
-- Organization = billing/membership container. Workspace = THE security
-- boundary. An organization may own many workspaces; a workspace belongs to
-- exactly one organization; data never crosses a workspace boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS workspaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  slug            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'Africa/Cairo',
  locale          text NOT NULL DEFAULT 'ar-EG',
  base_currency   char(3) NOT NULL DEFAULT 'USD',
  industry_pack   text,
  onboarding_state text NOT NULL DEFAULT 'draft'
    CHECK (onboarding_state IN ('draft','connection_pending','validating',
                                'permission_failed','discovering','snapshot_ready','failed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_org_slug_key
  ON workspaces (organization_id, slug);

CREATE TABLE IF NOT EXISTS memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  roles           text[] NOT NULL DEFAULT '{viewer}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_user_workspace_key
  ON memberships (user_id, workspace_id);
CREATE INDEX IF NOT EXISTS memberships_workspace_idx ON memberships (workspace_id);

CREATE TABLE IF NOT EXISTS roles (
  key         text PRIMARY KEY,
  label_ar    text NOT NULL,
  label_en    text NOT NULL,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_key   text NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_key, permission)
);

INSERT INTO roles (key, label_ar, label_en, description) VALUES
  ('workspace_owner',     'مالك مساحة العمل', 'Workspace owner',     'Membership, billing, secret rotation, break-glass'),
  ('data_admin',          'مسؤول البيانات',   'Data admin',          'Connections, schema, mappings, rebuilds, data quality'),
  ('financial_approver',  'معتمد مالي',       'Financial approver',  'Approves revenue, payment, refund, tax, currency, date policy'),
  ('dashboard_publisher', 'ناشر اللوحات',     'Dashboard publisher', 'Draft, publish and roll back dashboards'),
  ('analyst',             'محلل',             'Analyst',             'Approved metrics, drilldown, permitted exports'),
  ('viewer',              'مشاهد',            'Viewer',              'Read-only access to published dashboards')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Odoo connections
--
-- No secret material lives here. `connection_secret_refs` holds the ciphertext,
-- so UI code may select freely from `odoo_connections` with no leak risk.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS odoo_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  base_url         text NOT NULL,
  database         text NOT NULL,
  login            text NOT NULL,
  status           text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','validating','connected','permission_failed','failed')),
  odoo_version     text,
  last_tested_at   timestamptz,
  last_test_state  text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX IF NOT EXISTS odoo_connections_workspace_idx
  ON odoo_connections (workspace_id);
-- One live connection per workspace in this milestone; multi-connection is Phase 7.
CREATE UNIQUE INDEX IF NOT EXISTS odoo_connections_one_active
  ON odoo_connections (workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS connection_secret_refs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES odoo_connections(id) ON DELETE CASCADE,
  purpose       text NOT NULL DEFAULT 'odoo_api_key',
  adapter_id    text NOT NULL,
  key_id        text NOT NULL,
  -- Envelope-encrypted payload. AAD binds it to workspace_id + connection_id +
  -- key_id, so a ciphertext moved to another workspace's row fails to decrypt.
  ciphertext    text NOT NULL,
  iv            text NOT NULL,
  auth_tag      text NOT NULL,
  rotated_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connection_secret_refs_current
  ON connection_secret_refs (connection_id, purpose);
CREATE INDEX IF NOT EXISTS connection_secret_refs_workspace_idx
  ON connection_secret_refs (workspace_id);

-- ---------------------------------------------------------------------------
-- Schema snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL REFERENCES odoo_connections(id) ON DELETE CASCADE,
  contract_version integer NOT NULL DEFAULT 1,
  odoo_version     text,
  content_hash     char(64) NOT NULL,
  model_count      integer NOT NULL DEFAULT 0,
  field_count      integer NOT NULL DEFAULT 0,
  relation_count   integer NOT NULL DEFAULT 0,
  permission_gaps  jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'discovering'
    CHECK (status IN ('discovering','ready','failed')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS schema_snapshots_workspace_idx
  ON schema_snapshots (workspace_id, started_at DESC);
-- Unchanged metadata must not create a duplicate snapshot. Scoped by workspace
-- so two customers with identical Odoo layouts still get their own rows.
CREATE UNIQUE INDEX IF NOT EXISTS schema_snapshots_dedupe
  ON schema_snapshots (workspace_id, connection_id, content_hash)
  WHERE status = 'ready';

CREATE TABLE IF NOT EXISTS schema_models (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id  uuid NOT NULL REFERENCES schema_snapshots(id) ON DELETE CASCADE,
  model        text NOT NULL,
  label        text NOT NULL DEFAULT '',
  origin       text NOT NULL DEFAULT 'allowlist' CHECK (origin IN ('allowlist','relation')),
  accessible   boolean NOT NULL DEFAULT true,
  field_count  integer NOT NULL DEFAULT 0,
  record_count integer
);
CREATE UNIQUE INDEX IF NOT EXISTS schema_models_key
  ON schema_models (workspace_id, snapshot_id, model);

CREATE TABLE IF NOT EXISTS schema_fields (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id      uuid NOT NULL REFERENCES schema_snapshots(id) ON DELETE CASCADE,
  model            text NOT NULL,
  name             text NOT NULL,
  -- label/help are customer-controlled text. Stored as data, never as instructions.
  label            text NOT NULL DEFAULT '',
  help             text,
  type             text NOT NULL,
  relation         text,
  relation_field   text,
  required         boolean NOT NULL DEFAULT false,
  readonly         boolean NOT NULL DEFAULT false,
  stored           boolean NOT NULL DEFAULT true,
  computed         boolean NOT NULL DEFAULT false,
  is_custom        boolean NOT NULL DEFAULT false,
  selection_values jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS schema_fields_key
  ON schema_fields (workspace_id, snapshot_id, model, name);
CREATE INDEX IF NOT EXISTS schema_fields_custom_idx
  ON schema_fields (workspace_id, snapshot_id) WHERE is_custom;

CREATE TABLE IF NOT EXISTS schema_relations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id  uuid NOT NULL REFERENCES schema_snapshots(id) ON DELETE CASCADE,
  from_model   text NOT NULL,
  from_field   text NOT NULL,
  to_model     text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('many2one','one2many','many2many'))
);
CREATE UNIQUE INDEX IF NOT EXISTS schema_relations_key
  ON schema_relations (workspace_id, snapshot_id, from_model, from_field, to_model);

CREATE TABLE IF NOT EXISTS permission_gaps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id  uuid REFERENCES schema_snapshots(id) ON DELETE CASCADE,
  model        text NOT NULL,
  operation    text NOT NULL,
  reason       text NOT NULL,
  detail       text NOT NULL DEFAULT '',
  observed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS permission_gaps_workspace_idx
  ON permission_gaps (workspace_id, snapshot_id);

-- ---------------------------------------------------------------------------
-- Onboarding, jobs, generations, health
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onboarding_states (
  workspace_id  uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  step          text NOT NULL DEFAULT 'profile',
  completed_steps text[] NOT NULL DEFAULT '{}',
  -- Never contains secrets: the wizard posts the API key straight to the
  -- SecretStore and keeps only non-sensitive form state here.
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id  uuid REFERENCES odoo_connections(id) ON DELETE SET NULL,
  kind           text NOT NULL DEFAULT 'discovery',
  status         text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','interrupted','cancelled')),
  -- Resume point (ADR-0003). A crash resumes at the next unprocessed model.
  checkpoint     jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  error          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX IF NOT EXISTS sync_runs_workspace_idx
  ON sync_runs (workspace_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_idempotency
  ON sync_runs (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Per-workspace serialization: at most one live run per workspace and kind.
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_one_live
  ON sync_runs (workspace_id, kind) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS data_generations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id  uuid REFERENCES schema_snapshots(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'building'
    CHECK (status IN ('building','validated','published','rolled_back','failed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS data_generations_workspace_idx
  ON data_generations (workspace_id, created_at DESC);

-- The atomic publish/rollback point: flipping this row swaps generations.
CREATE TABLE IF NOT EXISTS active_generation_pointers (
  workspace_id  uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid REFERENCES data_generations(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_health_states (
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain          text NOT NULL,
  status          text NOT NULL DEFAULT 'never'
    CHECK (status IN ('never','success','stale','failed')),
  -- Separate on purpose: a failed attempt must never advance freshness.
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error      text,
  row_count       integer,
  PRIMARY KEY (workspace_id, domain)
);

-- ---------------------------------------------------------------------------
-- Audit log — append-only
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  target_type   text NOT NULL,
  target_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_workspace_idx
  ON audit_logs (workspace_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Row-Level Security
--
-- current_setting('app.workspace_id', true) returns NULL when unset.
-- `workspace_id = NULL` evaluates to NULL, which is not TRUE, so a query with
-- no workspace context sees ZERO rows rather than all rows. Fail-closed by
-- construction, not by a `WHERE` someone might forget.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

-- The signed-in user, for the one legitimate pre-workspace query: "which
-- workspaces may I enter?". Also NULL when unset, so it is fail-closed too.
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

DO $$
DECLARE
  t text;
  -- Tables reached only with a workspace already chosen.
  workspace_tables text[] := ARRAY[
    'odoo_connections','connection_secret_refs',
    'schema_snapshots','schema_models','schema_fields','schema_relations',
    'permission_gaps','onboarding_states','sync_runs','data_generations',
    'active_generation_pointers','data_health_states'
  ];
BEGIN
  FOREACH t IN ARRAY workspace_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_workspace_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id())',
      t || '_workspace_isolation', t);
  END LOOP;
END
$$;

-- audit_logs: append-only. SELECT and INSERT policies only — with FORCE RLS and
-- no UPDATE/DELETE policy, neither is possible for any role, including the owner.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_workspace_select ON audit_logs;
DROP POLICY IF EXISTS audit_logs_workspace_insert ON audit_logs;
CREATE POLICY audit_logs_workspace_select ON audit_logs
  FOR SELECT USING (workspace_id = current_workspace_id());
CREATE POLICY audit_logs_workspace_insert ON audit_logs
  FOR INSERT WITH CHECK (workspace_id = current_workspace_id());

-- memberships and workspaces need a second, narrower door.
--
-- Choosing a workspace necessarily happens BEFORE workspace context exists, so
-- a pure `workspace_id = current_workspace_id()` policy would make the workspace
-- picker return nothing. The extra predicate is scoped to the signed-in user's
-- own membership rows, which reveals only workspaces they already belong to.
-- With both settings unset, every branch is NULL and no rows are visible.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memberships_workspace_isolation ON memberships;
CREATE POLICY memberships_workspace_isolation ON memberships
  USING (
    workspace_id = current_workspace_id()
    OR user_id = current_app_user_id()
  )
  WITH CHECK (workspace_id = current_workspace_id());

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_workspace_isolation ON workspaces;
CREATE POLICY workspaces_workspace_isolation ON workspaces
  USING (
    id = current_workspace_id()
    OR EXISTS (
      SELECT 1 FROM memberships m
       WHERE m.workspace_id = workspaces.id
         AND m.user_id = current_app_user_id()
         AND m.deleted_at IS NULL
    )
  )
  WITH CHECK (id = current_workspace_id());

-- organizations: visible only to users holding a membership inside them.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organizations_member_isolation ON organizations;
CREATE POLICY organizations_member_isolation ON organizations
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
       WHERE m.organization_id = organizations.id
         AND (m.user_id = current_app_user_id()
              OR m.workspace_id = current_workspace_id())
         AND m.deleted_at IS NULL
    )
  )
  WITH CHECK (true);

-- Grants: the runtime role gets DML on workspace tables, read-only on the
-- reference tables, and INSERT/SELECT only on the audit log.
GRANT USAGE ON SCHEMA public TO insights_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  workspaces, memberships, odoo_connections, connection_secret_refs,
  schema_snapshots, schema_models, schema_fields, schema_relations,
  permission_gaps, onboarding_states, sync_runs, data_generations,
  active_generation_pointers, data_health_states
TO insights_app;
GRANT SELECT, INSERT ON audit_logs TO insights_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, users, accounts, sessions, verifications
TO insights_app;
GRANT SELECT ON roles, role_permissions TO insights_app;
