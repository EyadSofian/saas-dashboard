-- 0004 · Canonical layer, metrics and dashboards.
--
-- Canonical (Silver) tables are generic: they hold whatever the approved
-- manifest maps into them, for any customer. Nothing here encodes one company's
-- business rules.
--
-- Every fact row carries generation_id. Reads pin exactly one generation, so
-- rows computed under different mapping versions never mix in one answer, and
-- publishing is an atomic pointer flip rather than a destructive rewrite.

-- ------------------------------------------------------------- dimensions --
CREATE TABLE dim_company (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id     bigint NOT NULL,
  name          text NOT NULL DEFAULT '',
  currency_code char(3),
  PRIMARY KEY (workspace_id, generation_id, source_id)
);

CREATE TABLE dim_currency (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id     bigint NOT NULL,
  code          char(3) NOT NULL,
  rate          numeric(18,6),
  PRIMARY KEY (workspace_id, generation_id, source_id)
);

CREATE TABLE dim_user (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id     bigint NOT NULL,
  name          text NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, generation_id, source_id)
);

CREATE TABLE dim_team (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id     bigint NOT NULL,
  name          text NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, generation_id, source_id)
);

CREATE TABLE dim_partner (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id     bigint NOT NULL,
  name          text NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, generation_id, source_id)
);

CREATE TABLE dim_product (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id     bigint NOT NULL,
  name          text NOT NULL DEFAULT '',
  category      text,
  PRIMARY KEY (workspace_id, generation_id, source_id)
);

CREATE TABLE dim_stage (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id     bigint NOT NULL,
  name          text NOT NULL DEFAULT '',
  sequence      integer,
  -- Set from an APPROVED mapping, never guessed from the stage name.
  is_won        boolean,
  is_lost       boolean,
  PRIMARY KEY (workspace_id, generation_id, source_id)
);

-- ------------------------------------------------------------------ facts --
CREATE TABLE fact_lead (
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id    uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id        bigint NOT NULL,
  source_write_date timestamptz,
  created_at_utc   timestamptz,
  created_date_local date,
  closed_at_utc    timestamptz,
  closed_date_local  date,
  stage_id         bigint,
  team_id          bigint,
  user_id          bigint,
  partner_id       bigint,
  company_id       bigint,
  currency_code    char(3),
  expected_revenue numeric(18,4),
  is_won           boolean,
  is_lost          boolean,
  lost_reason      text,
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, generation_id, source_id)
);
CREATE INDEX fact_lead_created_idx ON fact_lead (workspace_id, generation_id, created_date_local);
CREATE INDEX fact_lead_closed_idx  ON fact_lead (workspace_id, generation_id, closed_date_local);

CREATE TABLE fact_order (
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id     uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id         bigint NOT NULL,
  source_write_date timestamptz,
  reference         text,
  ordered_at_utc    timestamptz,
  ordered_date_local date,
  state             text,
  is_confirmed      boolean,
  partner_id        bigint,
  user_id           bigint,
  team_id           bigint,
  company_id        bigint,
  currency_code     char(3),
  amount_total      numeric(18,4),
  lead_source_id    bigint,
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, generation_id, source_id)
);
CREATE INDEX fact_order_date_idx ON fact_order (workspace_id, generation_id, ordered_date_local);

CREATE TABLE fact_order_line (
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id     uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id         bigint NOT NULL,
  source_write_date timestamptz,
  order_id          bigint,
  product_id        bigint,
  quantity          numeric(18,4),
  subtotal          numeric(18,4),
  PRIMARY KEY (workspace_id, generation_id, source_id)
);
CREATE INDEX fact_order_line_order_idx ON fact_order_line (workspace_id, generation_id, order_id);

CREATE TABLE fact_invoice (
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id     uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id         bigint NOT NULL,
  source_write_date timestamptz,
  number            text,
  invoice_date      date,
  accounting_date   date,
  move_type         text,
  -- A credit note is a normal invoice with a negative sign, recognised on the
  -- date the approved policy names — not silently folded into the original month.
  is_credit_note    boolean NOT NULL DEFAULT false,
  state             text,
  payment_state     text,
  is_posted         boolean,
  is_paid           boolean,
  partner_id        bigint,
  company_id        bigint,
  currency_code     char(3),
  amount_total      numeric(18,4),
  amount_residual   numeric(18,4),
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, generation_id, source_id)
);
CREATE INDEX fact_invoice_date_idx ON fact_invoice (workspace_id, generation_id, invoice_date);

CREATE TABLE fact_payment (
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id     uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  source_id         bigint NOT NULL,
  source_write_date timestamptz,
  payment_date      date,
  partner_id        bigint,
  company_id        bigint,
  currency_code     char(3),
  amount            numeric(18,4),
  PRIMARY KEY (workspace_id, generation_id, source_id)
);
CREATE INDEX fact_payment_date_idx ON fact_payment (workspace_id, generation_id, payment_date);

-- ---------------------------------------------------------------- metrics --
CREATE TABLE metric_definitions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  manifest_id    uuid REFERENCES semantic_manifests(id) ON DELETE CASCADE,
  metric_key     text NOT NULL,
  label_ar       text NOT NULL,
  label_en       text NOT NULL,
  entity         text NOT NULL,
  base_grain     text NOT NULL,
  metric_kind    text NOT NULL DEFAULT 'additive'
    CHECK (metric_kind IN ('additive','semi_additive','non_additive')),
  unit           text NOT NULL DEFAULT 'number'
    CHECK (unit IN ('count','currency','percent','duration','number')),
  -- Validated AST with an operator allowlist. Never a SQL fragment.
  aggregation    jsonb NOT NULL,
  filters        jsonb NOT NULL DEFAULT '[]'::jsonb,
  date_field     text,
  date_policy_key text,
  numerator_key  text,
  denominator_key text,
  -- forbid | aggregate_before_join | distinct_entity
  fanout_policy  text NOT NULL DEFAULT 'forbid',
  allowed_dimensions text[] NOT NULL DEFAULT '{}',
  version        integer NOT NULL DEFAULT 1,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX metric_definitions_key ON metric_definitions (workspace_id, metric_key, version);

-- ------------------------------------------------------------- dashboards --
CREATE TABLE dashboards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key           text NOT NULL,
  title_ar      text NOT NULL,
  title_en      text NOT NULL,
  audience      text NOT NULL DEFAULT 'owner' CHECK (audience IN ('owner','manager','analyst')),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version       integer NOT NULL DEFAULT 1,
  -- The dashboard is DATA: widgets, layout and filters, not generated code.
  definition    jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at  timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dashboards_key ON dashboards (workspace_id, key, version);
CREATE INDEX dashboards_workspace_idx ON dashboards (workspace_id, status);

CREATE TABLE dashboard_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  definition   jsonb NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dashboard_versions_key ON dashboard_versions (workspace_id, dashboard_id, version);

SELECT apply_workspace_rls(t) FROM unnest(ARRAY[
  'dim_company'::regclass, 'dim_currency'::regclass, 'dim_user'::regclass,
  'dim_team'::regclass, 'dim_partner'::regclass, 'dim_product'::regclass,
  'dim_stage'::regclass,
  'fact_lead'::regclass, 'fact_order'::regclass, 'fact_order_line'::regclass,
  'fact_invoice'::regclass, 'fact_payment'::regclass,
  'metric_definitions'::regclass, 'dashboards'::regclass, 'dashboard_versions'::regclass
]) AS t;
