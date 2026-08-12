// Migration runner — additive and reversible (milestone acceptance A).
//
// Runs against a real PostgreSQL so "reversible" means the DDL actually
// reverses, not that a down script exists.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";
import { appliedMigrations, loadMigrations, migrateDown, migrateUp } from "@/platform/db/migrate";
import { closePool } from "@/platform/db/pool";

let database: TestDatabase;
let pool: Pool;

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return rows.length > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column],
  );
  return rows.length > 0;
}

beforeAll(async () => {
  database = await startTestDatabase();
  process.env.DATABASE_URL = database.url;
  pool = new Pool({ connectionString: database.url, max: 3 });

  // Stand in for the legacy tables the running product creates at runtime, so
  // the additive migration is exercised against realistic pre-existing state.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_rows (
      dataset text NOT NULL, stable_key text NOT NULL, row_data jsonb NOT NULL,
      record_date date, source_updated_at timestamptz,
      synced_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (dataset, stable_key));
    CREATE TABLE IF NOT EXISTS dashboard_sync_state (
      dataset text PRIMARY KEY, status text NOT NULL, row_count integer NOT NULL DEFAULT 0,
      synced_at timestamptz NOT NULL DEFAULT now(), error text NOT NULL DEFAULT '',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb);
  `);
  await pool.query(
    `INSERT INTO dashboard_rows (dataset, stable_key, row_data)
     VALUES ('crm','lead-1','{"name":"legacy"}'::jsonb) ON CONFLICT DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO dashboard_sync_state (dataset, status, row_count)
     VALUES ('crm','success',1) ON CONFLICT DO NOTHING`,
  );
}, 120_000);

afterAll(async () => {
  await closePool().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

describe("migration files", () => {
  it("loads in lexical order with a down script each", async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((m) => m.id)).toEqual([
      "0001_workspace_foundation",
      "0002_legacy_workspace_backfill",
    ]);
    for (const migration of migrations) {
      expect(migration.down.trim().length, `${migration.id} has no down script`).toBeGreaterThan(0);
    }
  });

  it("contains no destructive DDL against pre-existing tables", async () => {
    // Acceptance A: additive only. The legacy tables may gain a column; they
    // may never be dropped or have data removed.
    const migrations = await loadMigrations();
    for (const migration of migrations) {
      for (const legacy of ["dashboard_rows", "dashboard_sync_state"]) {
        expect(migration.up).not.toMatch(new RegExp(`DROP TABLE[^;]*${legacy}`, "i"));
        expect(migration.up).not.toMatch(new RegExp(`TRUNCATE[^;]*${legacy}`, "i"));
        expect(migration.up).not.toMatch(new RegExp(`DELETE FROM ${legacy}`, "i"));
      }
    }
  });
});

describe("migrateUp", () => {
  it("applies both migrations and records them", async () => {
    const { applied } = await migrateUp();
    expect(applied).toEqual(["0001_workspace_foundation", "0002_legacy_workspace_backfill"]);

    const recorded = await appliedMigrations();
    expect([...recorded.keys()]).toEqual([
      "0001_workspace_foundation",
      "0002_legacy_workspace_backfill",
    ]);
  });

  it("is idempotent — a second run applies nothing", async () => {
    const { applied, skipped } = await migrateUp();
    expect(applied).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it("creates the workspace tables", async () => {
    for (const table of [
      "organizations",
      "workspaces",
      "memberships",
      "odoo_connections",
      "connection_secret_refs",
      "schema_snapshots",
      "schema_fields",
      "sync_runs",
      "data_generations",
      "active_generation_pointers",
      "audit_logs",
    ]) {
      expect(await tableExists(table), `${table} was not created`).toBe(true);
    }
  });

  it("backfills the legacy tables without touching their data", async () => {
    expect(await columnExists("dashboard_rows", "workspace_id")).toBe(true);

    const { rows } = await pool.query(
      "SELECT workspace_id, row_data FROM dashboard_rows WHERE stable_key = 'lead-1'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe("00000000-0000-4000-8000-000000000001");
    // The original payload is untouched.
    expect(rows[0].row_data).toEqual({ name: "legacy" });
  });

  it("adds the column as NULLABLE, so the change stays reversible", async () => {
    const { rows } = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name='dashboard_rows' AND column_name='workspace_id'`,
    );
    expect(rows[0].is_nullable).toBe("YES");
  });

  it("seeds the reference workspace with the education pack", async () => {
    const { rows } = await pool.query(
      "SELECT name, industry_pack, timezone, base_currency FROM workspaces WHERE id = $1",
      ["00000000-0000-4000-8000-000000000001"],
    );
    expect(rows[0]).toMatchObject({
      industry_pack: "education",
      timezone: "Africa/Cairo",
      base_currency: "USD",
    });
  });

  it("records the frozen Engosoft reporting policies", async () => {
    const { rows } = await pool.query(
      "SELECT payload FROM onboarding_states WHERE workspace_id = $1",
      ["00000000-0000-4000-8000-000000000001"],
    );
    expect(rows[0].payload.policies).toMatchObject({
      revenueRecognition: "payment_date",
      creditNoteRecognition: "reversal_invoice_date",
      lostAcquisitionCohort: "lead_creation_date",
      lostMovement: "close_date",
    });
  });

  it("refuses to run a migration that was edited after being applied", async () => {
    await pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE id = $1", [
      "0001_workspace_foundation",
    ]);
    await expect(migrateUp()).rejects.toThrow(/was modified after being applied/);
    // Restore so later tests see a consistent state.
    const migrations = await loadMigrations();
    await pool.query("UPDATE schema_migrations SET checksum = $1 WHERE id = $2", [
      migrations[0].checksum,
      "0001_workspace_foundation",
    ]);
  });
});

describe("migrateDown", () => {
  it("rolls 0002 back, leaving legacy data intact", async () => {
    expect(await migrateDown()).toBe("0002_legacy_workspace_backfill");

    expect(await columnExists("dashboard_rows", "workspace_id")).toBe(false);
    const { rows } = await pool.query("SELECT row_data FROM dashboard_rows WHERE stable_key='lead-1'");
    // The legacy row survives the rollback — this is the property that makes
    // the expand step safe to deploy.
    expect(rows).toHaveLength(1);
    expect(rows[0].row_data).toEqual({ name: "legacy" });
  });

  it("rolls 0001 back completely", async () => {
    expect(await migrateDown()).toBe("0001_workspace_foundation");
    for (const table of ["workspaces", "odoo_connections", "audit_logs", "schema_snapshots"]) {
      expect(await tableExists(table), `${table} survived rollback`).toBe(false);
    }
    // ...and the legacy tables are still there, untouched.
    expect(await tableExists("dashboard_rows")).toBe(true);
  });

  it("re-applies cleanly after a full rollback", async () => {
    const { applied } = await migrateUp();
    expect(applied).toEqual(["0001_workspace_foundation", "0002_legacy_workspace_backfill"]);
    expect(await tableExists("workspaces")).toBe(true);
    expect(await columnExists("dashboard_rows", "workspace_id")).toBe(true);
  });
});
