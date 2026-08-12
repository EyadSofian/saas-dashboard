-- Data repair is intentionally irreversible: a recovered job may already have
-- produced a valid snapshot by rollback time, and marking it failed again would
-- destroy truthful operational state. Rolling back this migration therefore
-- only removes its schema_migrations record.
SELECT 1;
