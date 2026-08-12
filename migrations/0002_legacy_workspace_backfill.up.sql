-- 0002 · Legacy workspace backfill
--
-- Expand step of expand/migrate/contract. Adds a NULLABLE workspace_id to the
-- two pre-existing tables and backfills them to the Engosoft reference
-- workspace. Legacy readers never select the column, so the app keeps working
-- unchanged in both directions.
--
-- Deliberately NOT here: NOT NULL, and RLS on these two tables. Both are
-- irreversible in practice and need the backfill verified against production
-- first. See docs/product/TENANCY_INVARIANTS.md §4.

-- Fixed UUIDs make this migration idempotent and let isolation tests reference
-- the reference workspace without a lookup.
INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-4000-8000-000000000000', 'Engosoft', 'engosoft')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspaces (
  id, organization_id, name, slug,
  timezone, locale, base_currency, industry_pack, onboarding_state
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000000',
  'Engosoft — Reference', 'reference',
  'Africa/Cairo', 'ar-EG', 'USD', 'education', 'draft'
)
ON CONFLICT (id) DO NOTHING;

-- The legacy tables are created lazily at runtime by ensureSchema(), so they
-- may not exist yet in a fresh database. Guard rather than fail.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'dashboard_rows') THEN
    ALTER TABLE dashboard_rows ADD COLUMN IF NOT EXISTS workspace_id uuid;
    CREATE INDEX IF NOT EXISTS dashboard_rows_workspace_idx
      ON dashboard_rows (workspace_id, dataset);
    UPDATE dashboard_rows
       SET workspace_id = '00000000-0000-4000-8000-000000000001'
     WHERE workspace_id IS NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'dashboard_sync_state') THEN
    ALTER TABLE dashboard_sync_state ADD COLUMN IF NOT EXISTS workspace_id uuid;
    UPDATE dashboard_sync_state
       SET workspace_id = '00000000-0000-4000-8000-000000000001'
     WHERE workspace_id IS NULL;
  END IF;
END
$$;

-- Seed the reference workspace's reporting policies, frozen from the current
-- Engosoft implementation. These become the education pack defaults; see
-- docs/product/REFERENCE_TENANT_BASELINE.md §2.
INSERT INTO onboarding_states (workspace_id, step, completed_steps, payload)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'profile',
  '{}',
  jsonb_build_object(
    'referenceWorkspace', true,
    'policies', jsonb_build_object(
      'revenueRecognition',    'payment_date',
      'creditNoteRecognition', 'reversal_invoice_date',
      'creditNoteSign',        'negative',
      'lostAcquisitionCohort', 'lead_creation_date',
      'lostMovement',          'close_date',
      'currency',              'convert_at_transaction_date',
      'reportingWindowStart',  '2026-01-01'
    ),
    'odooCompanyIds', jsonb_build_array(2, 3, 4)
  )
)
ON CONFLICT (workspace_id) DO NOTHING;

INSERT INTO data_health_states (workspace_id, domain, status)
SELECT '00000000-0000-4000-8000-000000000001', d, 'never'
  FROM unnest(ARRAY['discovery','crm','sales','accounting','marketing']) AS d
ON CONFLICT (workspace_id, domain) DO NOTHING;
