-- 0001 · Foundation: identity, tenancy, connections, jobs, audit.
--
-- workspace_id is the product's only isolation key. There is no tenant_id, and
-- a build-time guard fails if one appears.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Runtime role
--
-- The application connects as `insights_app`, which is NOT the table owner and
-- is NOBYPASSRLS. Migrations run as the connecting (admin) role. Without this
-- separation FORCE ROW LEVEL SECURITY is meaningless: a table owner silently
-- bypasses every policy.
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
-- Identity (Better Auth owns these shapes)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  name           text NOT NULL DEFAULT '',
  email_verified boolean NOT NULL DEFAULT false,
  image          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE accounts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  access_token             text,
  refresh_token            text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  id_token                 text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_provider_key ON accounts (provider_id, account_id);
CREATE INDEX accounts_user_idx ON accounts (user_id);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE verifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE workspaces (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name             text NOT NULL,
  slug             text NOT NULL,
  timezone         text NOT NULL DEFAULT 'UTC',
  locale           text NOT NULL DEFAULT 'ar-EG',
  base_currency    char(3) NOT NULL DEFAULT 'USD',
  industry_pack    text,
  onboarding_state text NOT NULL DEFAULT 'draft'
    CHECK (onboarding_state IN ('draft','connection_pending','validating','permission_failed',
                                'discovering','snapshot_ready','mapping_review','published','failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX workspaces_org_slug_key ON workspaces (organization_id, slug);

CREATE TABLE roles (
  key         text PRIMARY KEY,
  label_ar    text NOT NULL,
  label_en    text NOT NULL,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE role_permissions (
  role_key   text NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_key, permission)
);

INSERT INTO roles (key, label_ar, label_en, description) VALUES
  ('workspace_owner',     'مالك مساحة العمل', 'Workspace owner',     'Membership, billing, secret rotation'),
  ('data_admin',          'مسؤول البيانات',   'Data admin',          'Connections, schema, mappings, rebuilds'),
  ('financial_approver',  'معتمد مالي',       'Financial approver',  'Approves revenue, payment, refund, tax, currency and date policy'),
  ('dashboard_publisher', 'ناشر اللوحات',     'Dashboard publisher', 'Draft, publish and roll back dashboards'),
  ('analyst',             'محلل',             'Analyst',             'Approved metrics, drilldown, permitted exports'),
  ('viewer',              'مشاهد',            'Viewer',              'Read-only access to published dashboards');

CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  roles           text[] NOT NULL DEFAULT '{viewer}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE UNIQUE INDEX memberships_user_workspace_key ON memberships (user_id, workspace_id);
CREATE INDEX memberships_workspace_idx ON memberships (workspace_id);

-- ---------------------------------------------------------------------------
-- Odoo connections
--
-- No secret material lives in `odoo_connections`: the ciphertext is in
-- `connection_secret_refs`, so UI code may select the connection row freely.
-- ---------------------------------------------------------------------------
CREATE TABLE odoo_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  base_url        text NOT NULL,
  database        text NOT NULL,
  login           text NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','validating','connected','permission_failed','failed')),
  odoo_version    text,
  last_tested_at  timestamptz,
  last_test_state text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX odoo_connections_workspace_idx ON odoo_connections (workspace_id);
CREATE UNIQUE INDEX odoo_connections_one_active
  ON odoo_connections (workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE connection_secret_refs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES odoo_connections(id) ON DELETE CASCADE,
  purpose       text NOT NULL DEFAULT 'odoo_api_key',
  adapter_id    text NOT NULL,
  key_id        text NOT NULL,
  -- Envelope-encrypted. AAD binds the ciphertext to workspace + connection +
  -- key version, so a ciphertext moved between rows fails to decrypt.
  ciphertext    text NOT NULL,
  iv            text NOT NULL,
  auth_tag      text NOT NULL,
  rotated_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connection_secret_refs_current ON connection_secret_refs (connection_id, purpose);
CREATE INDEX connection_secret_refs_workspace_idx ON connection_secret_refs (workspace_id);

-- ---------------------------------------------------------------------------
-- Onboarding, jobs, generations, health
-- ---------------------------------------------------------------------------
CREATE TABLE onboarding_states (
  workspace_id    uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  step            text NOT NULL DEFAULT 'profile',
  completed_steps text[] NOT NULL DEFAULT '{}',
  -- Never holds secrets: the wizard posts the API key straight to the
  -- SecretStore and keeps only non-sensitive form state here.
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id   uuid REFERENCES odoo_connections(id) ON DELETE SET NULL,
  kind            text NOT NULL DEFAULT 'discovery',
  status          text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','interrupted','cancelled')),
  -- Resume point. A crash continues at the next unprocessed unit.
  checkpoint      jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX sync_runs_workspace_idx ON sync_runs (workspace_id, started_at DESC);
CREATE UNIQUE INDEX sync_runs_idempotency
  ON sync_runs (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- At most one live run per workspace and kind: a double-click cannot start two
-- concurrent scans of the same customer's Odoo.
CREATE UNIQUE INDEX sync_runs_one_live
  ON sync_runs (workspace_id, kind) WHERE status IN ('queued','running');

CREATE TABLE data_generations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id  uuid,
  manifest_id  uuid,
  status       text NOT NULL DEFAULT 'building'
    CHECK (status IN ('building','validated','published','rolled_back','failed')),
  row_counts   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX data_generations_workspace_idx ON data_generations (workspace_id, created_at DESC);

-- The atomic publish/rollback point: flipping this row swaps generations.
CREATE TABLE active_generation_pointers (
  workspace_id  uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid REFERENCES data_generations(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE data_health_states (
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain          text NOT NULL,
  status          text NOT NULL DEFAULT 'never'
    CHECK (status IN ('never','success','stale','failed')),
  -- Separate columns on purpose: a failed attempt must never advance freshness.
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error      text,
  row_count       integer,
  PRIMARY KEY (workspace_id, domain)
);

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  target_type   text NOT NULL,
  target_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_workspace_idx ON audit_logs (workspace_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Row-Level Security
--
-- current_setting('app.workspace_id', true) is NULL when unset, and
-- `workspace_id = NULL` is NULL — not TRUE. A query with no workspace context
-- therefore sees ZERO rows rather than all rows: fail-closed by construction,
-- not by a WHERE clause someone has to remember.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

-- The signed-in user, for the one legitimate pre-workspace query: "which
-- workspaces may I enter?". Also NULL when unset, so also fail-closed.
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- Applies the standard workspace policy to a table. Later migrations call this
-- rather than restating the policy, so the rule cannot drift between tables.
CREATE OR REPLACE FUNCTION apply_workspace_rls(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  name text := target::text;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', name);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', name);
  EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %s', name);
  EXECUTE format(
    'CREATE POLICY workspace_isolation ON %s USING (workspace_id = current_workspace_id()) '
    'WITH CHECK (workspace_id = current_workspace_id())', name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO insights_app', name);
END
$$;

SELECT apply_workspace_rls(t) FROM unnest(ARRAY[
  'odoo_connections'::regclass, 'connection_secret_refs'::regclass,
  'onboarding_states'::regclass, 'sync_runs'::regclass,
  'data_generations'::regclass, 'active_generation_pointers'::regclass,
  'data_health_states'::regclass
]) AS t;

-- audit_logs: append-only. SELECT and INSERT policies only — with FORCE RLS and
-- no UPDATE/DELETE policy, neither is possible for any role including the owner.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_select ON audit_logs
  FOR SELECT USING (workspace_id = current_workspace_id());
CREATE POLICY audit_logs_insert ON audit_logs
  FOR INSERT WITH CHECK (workspace_id = current_workspace_id());

-- memberships and workspaces need a second, narrower door: choosing a workspace
-- necessarily happens BEFORE workspace context exists, so a pure
-- `workspace_id = current_workspace_id()` policy would make the picker empty.
-- The extra predicate is scoped to the signed-in user's own membership rows.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_isolation ON memberships
  USING (workspace_id = current_workspace_id() OR user_id = current_app_user_id())
  WITH CHECK (workspace_id = current_workspace_id());

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_isolation ON workspaces
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

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_isolation ON organizations
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
       WHERE m.organization_id = organizations.id
         AND (m.user_id = current_app_user_id() OR m.workspace_id = current_workspace_id())
         AND m.deleted_at IS NULL
    )
  )
  WITH CHECK (true);

GRANT USAGE ON SCHEMA public TO insights_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces, memberships, organizations TO insights_app;
GRANT SELECT, INSERT ON audit_logs TO insights_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, accounts, sessions, verifications TO insights_app;
GRANT SELECT ON roles, role_permissions TO insights_app;
