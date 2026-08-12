-- 0005 · Durable jobs and incremental sync state.
--
-- Replaces the in-process job runner. A job now lives in the database, so it
-- survives a process restart and can be claimed by any replica — the two
-- limitations that capped the product at a single instance.

CREATE TABLE job_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  -- Resume point. A crash continues from here instead of restarting.
  checkpoint      jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  -- A claim is a lease, not a lock: if the worker holding it dies, the lease
  -- expires and another worker picks the job up from its checkpoint. A plain
  -- lock would strand the job until someone noticed.
  leased_by       text,
  leased_until    timestamptz,
  run_after       timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

CREATE INDEX job_queue_claimable_idx
  ON job_queue (run_after, created_at) WHERE status = 'queued';
CREATE INDEX job_queue_workspace_idx ON job_queue (workspace_id, kind, status);
CREATE UNIQUE INDEX job_queue_idempotency
  ON job_queue (workspace_id, kind, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- At most one live job per workspace and kind: a double-click, a retry and a
-- schedule firing at once must not start three concurrent scans of one Odoo.
CREATE UNIQUE INDEX job_queue_one_live
  ON job_queue (workspace_id, kind) WHERE status IN ('queued','running');

-- Incremental sync state: where the last successful read of each model stopped.
CREATE TABLE sync_watermarks (
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity            text NOT NULL,
  -- Composite (write_date, id): a plain timestamp loses rows that share the
  -- same second, and Odoo writes many rows per second during an import.
  last_write_date   timestamptz,
  last_source_id    bigint,
  last_full_sync_at timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity)
);

-- Records that vanished from Odoo — deleted, unposted, or no longer matching an
-- approved domain. Without this an incremental sync can only ever add.
CREATE TABLE sync_tombstones (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity       text NOT NULL,
  source_id    bigint NOT NULL,
  reason       text NOT NULL DEFAULT 'absent_from_source',
  observed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity, source_id)
);

CREATE TABLE workspace_schedules (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  interval_minutes integer NOT NULL DEFAULT 60,
  enabled       boolean NOT NULL DEFAULT true,
  last_run_at   timestamptz,
  next_run_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind)
);

SELECT apply_workspace_rls(t) FROM unnest(ARRAY[
  'job_queue'::regclass, 'sync_watermarks'::regclass,
  'sync_tombstones'::regclass, 'workspace_schedules'::regclass
]) AS t;

-- The claim query runs before workspace context exists — a worker asks "what
-- should I work on?" across all workspaces, then adopts the context of the job
-- it won. That query therefore runs as the admin role, and this policy exists
-- so the runtime role can still read and update its own workspace's jobs.
GRANT SELECT, INSERT, UPDATE ON job_queue TO insights_app;
