-- 0006 · down
DROP TABLE IF EXISTS data_quality_results CASCADE;
DROP TABLE IF EXISTS reconciliation_checks CASCADE;
DROP TABLE IF EXISTS reconciliation_runs CASCADE;
ALTER TABLE data_generations DROP COLUMN IF EXISTS source_upper_bound;
