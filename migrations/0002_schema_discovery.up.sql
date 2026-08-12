-- 0002 · Schema discovery: the frozen description of one customer's Odoo.
--
-- `label` and `help` are customer-controlled strings. They are stored and
-- displayed as data and are never interpolated into instructions or into a
-- query path — the mapping model treats them as untrusted input.

CREATE TABLE schema_snapshots (
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
CREATE INDEX schema_snapshots_workspace_idx ON schema_snapshots (workspace_id, started_at DESC);
-- Unchanged metadata must not create a duplicate snapshot. Scoped by workspace,
-- so two customers with identical Odoo layouts still get their own rows.
CREATE UNIQUE INDEX schema_snapshots_dedupe
  ON schema_snapshots (workspace_id, connection_id, content_hash) WHERE status = 'ready';

CREATE TABLE schema_models (
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
CREATE UNIQUE INDEX schema_models_key ON schema_models (workspace_id, snapshot_id, model);

CREATE TABLE schema_fields (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id      uuid NOT NULL REFERENCES schema_snapshots(id) ON DELETE CASCADE,
  model            text NOT NULL,
  name             text NOT NULL,
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
CREATE UNIQUE INDEX schema_fields_key ON schema_fields (workspace_id, snapshot_id, model, name);
CREATE INDEX schema_fields_custom_idx ON schema_fields (workspace_id, snapshot_id) WHERE is_custom;

CREATE TABLE schema_relations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id  uuid NOT NULL REFERENCES schema_snapshots(id) ON DELETE CASCADE,
  from_model   text NOT NULL,
  from_field   text NOT NULL,
  to_model     text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('many2one','one2many','many2many'))
);
CREATE UNIQUE INDEX schema_relations_key
  ON schema_relations (workspace_id, snapshot_id, from_model, from_field, to_model);

CREATE TABLE permission_gaps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id  uuid REFERENCES schema_snapshots(id) ON DELETE CASCADE,
  model        text NOT NULL,
  operation    text NOT NULL,
  reason       text NOT NULL,
  detail       text NOT NULL DEFAULT '',
  observed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX permission_gaps_workspace_idx ON permission_gaps (workspace_id, snapshot_id);

SELECT apply_workspace_rls(t) FROM unnest(ARRAY[
  'schema_snapshots'::regclass, 'schema_models'::regclass, 'schema_fields'::regclass,
  'schema_relations'::regclass, 'permission_gaps'::regclass
]) AS t;
