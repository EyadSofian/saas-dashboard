-- 0001 · down
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS data_health_states CASCADE;
DROP TABLE IF EXISTS active_generation_pointers CASCADE;
DROP TABLE IF EXISTS data_generations CASCADE;
DROP TABLE IF EXISTS sync_runs CASCADE;
DROP TABLE IF EXISTS onboarding_states CASCADE;
DROP TABLE IF EXISTS connection_secret_refs CASCADE;
DROP TABLE IF EXISTS odoo_connections CASCADE;
DROP TABLE IF EXISTS memberships CASCADE;
DROP TABLE IF EXISTS role_permissions CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP TABLE IF EXISTS verifications CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS accounts CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP FUNCTION IF EXISTS apply_workspace_rls(regclass);
DROP FUNCTION IF EXISTS current_workspace_id();
DROP FUNCTION IF EXISTS current_app_user_id();

-- The role is left in place: it may hold grants on objects outside this
-- migration. Remove it manually with DROP ROLE insights_app when decommissioning.
