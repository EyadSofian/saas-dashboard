-- 0002 · down
--
-- Removes the added columns and the seeded reference rows. Legacy readers never
-- selected workspace_id, so dropping it restores the exact prior behaviour and
-- loses no legacy data.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'dashboard_rows') THEN
    DROP INDEX IF EXISTS dashboard_rows_workspace_idx;
    ALTER TABLE dashboard_rows DROP COLUMN IF EXISTS workspace_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'dashboard_sync_state') THEN
    ALTER TABLE dashboard_sync_state DROP COLUMN IF EXISTS workspace_id;
  END IF;
END
$$;

DELETE FROM data_health_states
 WHERE workspace_id = '00000000-0000-4000-8000-000000000001';
DELETE FROM onboarding_states
 WHERE workspace_id = '00000000-0000-4000-8000-000000000001';
DELETE FROM workspaces
 WHERE id = '00000000-0000-4000-8000-000000000001';
DELETE FROM organizations
 WHERE id = '00000000-0000-4000-8000-000000000000';
