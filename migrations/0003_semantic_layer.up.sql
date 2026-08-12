-- 0003 · Semantic layer: the approved meaning of a customer's data.
--
-- A manifest is declarative DATA, never executable code. Transforms and metric
-- expressions are validated ASTs with an operator allowlist, so a manifest is
-- something a business user can approve rather than code that runs because a
-- model wrote it.

CREATE TABLE semantic_manifests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id   uuid NOT NULL REFERENCES schema_snapshots(id) ON DELETE RESTRICT,
  version       integer NOT NULL,
  status        text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','in_review','approved','published','superseded')),
  content_hash  char(64),
  business      jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at  timestamptz,
  published_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX semantic_manifests_version ON semantic_manifests (workspace_id, version);
CREATE INDEX semantic_manifests_workspace_idx ON semantic_manifests (workspace_id, created_at DESC);

CREATE TABLE semantic_entity_mappings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  manifest_id    uuid NOT NULL REFERENCES semantic_manifests(id) ON DELETE CASCADE,
  canonical_entity text NOT NULL,
  odoo_model     text NOT NULL,
  primary_key    text NOT NULL DEFAULT 'id',
  -- Guards against a metric multiplying through a one-to-many join.
  grain          text NOT NULL DEFAULT 'document',
  domain_filter  jsonb NOT NULL DEFAULT '[]'::jsonb,
  status         text NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('needs_review','approved','rejected','unavailable')),
  confidence     numeric(4,3),
  evidence       jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at    timestamptz
);
CREATE UNIQUE INDEX semantic_entity_key
  ON semantic_entity_mappings (workspace_id, manifest_id, canonical_entity);

CREATE TABLE semantic_field_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  manifest_id     uuid NOT NULL REFERENCES semantic_manifests(id) ON DELETE CASCADE,
  canonical_field text NOT NULL,
  odoo_model      text,
  odoo_field      text,
  relation_path   text[] NOT NULL DEFAULT '{}',
  transform       jsonb,
  confidence      numeric(4,3),
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
  alternatives    jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_level      text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high')),
  -- Money, lifecycle and date-policy mappings are always true, whatever the
  -- model's confidence.
  requires_human_approval boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('needs_review','approved','rejected','unavailable')),
  explanation_ar  text NOT NULL DEFAULT '',
  explanation_en  text NOT NULL DEFAULT '',
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz
);
CREATE UNIQUE INDEX semantic_field_key
  ON semantic_field_mappings (workspace_id, manifest_id, canonical_field);
CREATE INDEX semantic_field_review_idx
  ON semantic_field_mappings (workspace_id, manifest_id, status);

CREATE TABLE reporting_policies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  manifest_id  uuid NOT NULL REFERENCES semantic_manifests(id) ON DELETE CASCADE,
  policy_key   text NOT NULL,
  value        text NOT NULL,
  options      jsonb NOT NULL DEFAULT '[]'::jsonb,
  status       text NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('needs_review','approved','rejected')),
  question_ar  text NOT NULL DEFAULT '',
  question_en  text NOT NULL DEFAULT '',
  approved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at  timestamptz
);
CREATE UNIQUE INDEX reporting_policies_key ON reporting_policies (workspace_id, manifest_id, policy_key);

-- Questions phrased for a business user, not a developer.
CREATE TABLE business_questions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  manifest_id  uuid NOT NULL REFERENCES semantic_manifests(id) ON DELETE CASCADE,
  question_key text NOT NULL,
  question_ar  text NOT NULL,
  question_en  text NOT NULL,
  options      jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer       text,
  answered_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  answered_at  timestamptz
);
CREATE UNIQUE INDEX business_questions_key ON business_questions (workspace_id, manifest_id, question_key);

-- Every AI call is recorded: prompt version, model, tokens, latency, and the
-- hash of the exact snapshot it saw. Without the input hash a proposal cannot
-- be reproduced or audited.
CREATE TABLE ai_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purpose           text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  prompt_version    text NOT NULL,
  input_hash        char(64) NOT NULL,
  output_hash       char(64),
  input_tokens      integer,
  output_tokens     integer,
  latency_ms        integer,
  schema_retries    integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'succeeded'
    CHECK (status IN ('succeeded','schema_failed','provider_failed','skipped')),
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_runs_workspace_idx ON ai_runs (workspace_id, created_at DESC);
-- An unchanged snapshot reuses the previous proposal instead of paying again.
CREATE INDEX ai_runs_cache_idx ON ai_runs (workspace_id, purpose, input_hash);

SELECT apply_workspace_rls(t) FROM unnest(ARRAY[
  'semantic_manifests'::regclass, 'semantic_entity_mappings'::regclass,
  'semantic_field_mappings'::regclass, 'reporting_policies'::regclass,
  'business_questions'::regclass, 'ai_runs'::regclass
]) AS t;
