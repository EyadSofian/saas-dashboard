-- 0007 · down
DROP TABLE IF EXISTS saved_views CASCADE;
DROP INDEX IF EXISTS dashboards_one_default;
ALTER TABLE dashboards DROP COLUMN IF EXISTS is_default;
ALTER TABLE dashboards DROP COLUMN IF EXISTS updated_by;
