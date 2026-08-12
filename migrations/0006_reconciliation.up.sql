-- 0006 · Reconciliation and data quality.
--
-- A generation is not published because the extract finished. It is published
-- because it was checked against the source and matched.

-- The instant the extract read up to. Reconciliation must ask Odoo the same
-- question about the same moment: a count taken later would include rows
-- written after the extract and report a difference that is not an error.
ALTER TABLE data_generations ADD COLUMN IF NOT EXISTS source_upper_bound timestamptz;

CREATE TABLE reconciliation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES data_generations(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','passed','failed','accepted_with_warnings','error')),
  -- Set when a human knowingly publishes past a non-critical difference. A
  -- critical one can never be accepted this way.
  accepted_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at   timestamptz,
  accepted_note text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX reconciliation_runs_workspace_idx
  ON reconciliation_runs (workspace_id, started_at DESC);

CREATE TABLE reconciliation_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  check_key      text NOT NULL,
  entity         text NOT NULL,
  measure        text NOT NULL CHECK (measure IN ('row_count','sum')),
  -- Financial measures are critical: a difference blocks publication rather
  -- than warning about it. A dimension count is a warning.
  severity       text NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical','warning','info')),
  source_value   numeric(20,4),
  canonical_value numeric(20,4),
  difference     numeric(20,4),
  -- Fractional, e.g. 0.005 = 0.5%. Counts use 0.
  tolerance      numeric(10,6) NOT NULL DEFAULT 0,
  passed         boolean NOT NULL DEFAULT false,
  -- Set when the source could not answer at all: a permission gap is not a
  -- mismatch, and reporting it as one would be a lie in the other direction.
  unavailable_reason text,
  checked_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reconciliation_checks_key
  ON reconciliation_checks (workspace_id, run_id, check_key);
CREATE INDEX reconciliation_checks_failed_idx
  ON reconciliation_checks (workspace_id, run_id) WHERE NOT passed;

-- Per-workspace assertions about the shape of the data, independent of Odoo.
CREATE TABLE data_quality_results (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  rule_key     text NOT NULL,
  entity       text NOT NULL,
  severity     text NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical','warning','info')),
  failing_rows integer NOT NULL DEFAULT 0,
  total_rows   integer NOT NULL DEFAULT 0,
  passed       boolean NOT NULL DEFAULT true,
  detail       text NOT NULL DEFAULT '',
  checked_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX data_quality_results_key
  ON data_quality_results (workspace_id, run_id, rule_key);

SELECT apply_workspace_rls(t) FROM unnest(ARRAY[
  'reconciliation_runs'::regclass, 'reconciliation_checks'::regclass,
  'data_quality_results'::regclass
]) AS t;
