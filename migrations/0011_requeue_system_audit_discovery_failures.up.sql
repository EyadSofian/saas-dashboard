-- 0011 · Recover discovery jobs that the system-audit actor bug exhausted.
--
-- Durable workers intentionally use a sentinel UUID as their in-memory actor.
-- Before the accompanying application fix, audit writes tried to persist that
-- UUID into audit_logs.actor_user_id. The foreign key rejected it, exhausting
-- an otherwise healthy discovery job before its snapshot could be published.
--
-- Requeue only the newest job per affected workspace and only when no live
-- discovery already exists. This keeps job_queue_one_live valid and avoids
-- reviving unrelated Odoo, permission, timeout, or connector failures.
WITH ranked_failures AS (
  SELECT
    failed.id,
    row_number() OVER (
      PARTITION BY failed.workspace_id
      ORDER BY failed.finished_at DESC NULLS LAST, failed.created_at DESC, failed.id DESC
    ) AS recovery_rank
  FROM job_queue AS failed
  WHERE failed.kind = 'discovery'
    AND failed.status = 'failed'
    AND position(
      'audit_logs_actor_user_id_fkey' IN coalesce(failed.error, '')
    ) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM job_queue AS live
      WHERE live.workspace_id = failed.workspace_id
        AND live.kind = 'discovery'
        AND live.status IN ('queued', 'running')
    )
), recovery_candidates AS (
  SELECT id
  FROM ranked_failures
  WHERE recovery_rank = 1
)
UPDATE job_queue AS job
SET
  status = 'queued',
  attempts = 0,
  max_attempts = greatest(job.max_attempts, 3),
  run_after = now(),
  error = NULL,
  leased_by = NULL,
  leased_until = NULL,
  started_at = NULL,
  finished_at = NULL
FROM recovery_candidates AS candidate
WHERE job.id = candidate.id;
