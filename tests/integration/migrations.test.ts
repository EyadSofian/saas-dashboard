// Migration runner, against a real PostgreSQL.
//
// "Reversible" has to mean the DDL actually reverses, not that a down file
// exists — so every migration is applied, rolled back, and re-applied here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";
import { appliedMigrations, loadMigrations, migrateDown, migrateUp } from "@/platform/db/migrate";
import { closePool } from "@/platform/db/pool";

const EXPECTED_ORDER = [
  "0001_foundation",
  "0002_schema_discovery",
  "0003_semantic_layer",
  "0004_canonical_and_dashboards",
  "0005_durable_jobs_and_watermarks",
  "0006_reconciliation",
  "0007_dashboard_builder",
  "0008_copilot",
  "0009_plans_and_lifecycle",
  "0010_invitations",
];

let database: TestDatabase;
let pool: Pool;

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return rows.length > 0;
}

beforeAll(async () => {
  database = await startTestDatabase();
  process.env.DATABASE_URL = database.url;
  pool = new Pool({ connectionString: database.url, max: 3 });
}, 120_000);

afterAll(async () => {
  await closePool().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

describe("migration files", () => {
  it("loads in dependency order with a down script each", async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((m) => m.id)).toEqual(EXPECTED_ORDER);
    for (const migration of migrations) {
      expect(migration.down.trim().length, `${migration.id} has no down script`).toBeGreaterThan(0);
    }
  });

  it("carries no reference to the previous product's tables or data", async () => {
    // This repository is a clean start. A stray legacy table name would mean
    // someone reintroduced the old schema by copy-paste.
    const migrations = await loadMigrations();
    for (const migration of migrations) {
      const sql = migration.up.toLowerCase();
      for (const legacy of ["dashboard_rows", "dashboard_sync_state", "engosoft", "sheet_id"]) {
        expect(sql, `${migration.id} references ${legacy}`).not.toContain(legacy);
      }
    }
  });
});

describe("migrateUp", () => {
  it("applies every migration and records them", async () => {
    const { applied } = await migrateUp();
    expect(applied).toEqual(EXPECTED_ORDER);
    expect([...(await appliedMigrations()).keys()]).toEqual(EXPECTED_ORDER);
  });

  it("is idempotent — a second run applies nothing", async () => {
    const { applied, skipped } = await migrateUp();
    expect(applied).toEqual([]);
    expect(skipped).toHaveLength(EXPECTED_ORDER.length);
  });

  it("creates the tenancy and identity tables", async () => {
    for (const table of [
      "users",
      "sessions",
      "organizations",
      "workspaces",
      "memberships",
      "odoo_connections",
      "connection_secret_refs",
      "audit_logs",
      "data_health_states",
    ]) {
      expect(await tableExists(table), `${table} missing`).toBe(true);
    }
  });

  it("creates the discovery, semantic, canonical and dashboard tables", async () => {
    for (const table of [
      "schema_snapshots",
      "schema_fields",
      "semantic_manifests",
      "semantic_field_mappings",
      "reporting_policies",
      "business_questions",
      "ai_runs",
      "dim_company",
      "fact_lead",
      "fact_invoice",
      "metric_definitions",
      "dashboards",
      "job_queue",
      "sync_watermarks",
      "sync_tombstones",
      "reconciliation_runs",
      "reconciliation_checks",
      "data_quality_results",
      "saved_views",
      "copilot_conversations",
      "copilot_messages",
      "plans",
      "workspace_subscriptions",
      "usage_events",
      "deletion_requests",
      "workspace_invitations",
    ]) {
      expect(await tableExists(table), `${table} missing`).toBe(true);
    }
  });

  it("puts workspace_id on every workspace-owned table", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`,
    );
    expect(rows.length).toBeGreaterThan(20);

    for (const { table_name } of rows) {
      // `workspaces` is keyed by id; everything else must carry workspace_id.
      if (table_name === "workspaces" || table_name === "organizations") continue;
      const { rows: columns } = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'workspace_id'`,
        [table_name],
      );
      expect(columns, `${table_name} has RLS but no workspace_id`).toHaveLength(1);
    }
  });

  it("refuses a migration that was edited after being applied", async () => {
    await pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE id = $1", [
      "0001_foundation",
    ]);
    await expect(migrateUp()).rejects.toThrow(/was modified after being applied/);

    const migrations = await loadMigrations();
    await pool.query("UPDATE schema_migrations SET checksum = $1 WHERE id = $2", [
      migrations[0].checksum,
      "0001_foundation",
    ]);
  });
});

describe("migrateDown", () => {
  it("rolls every migration back in reverse order", async () => {
    for (const id of [...EXPECTED_ORDER].reverse()) {
      expect(await migrateDown()).toBe(id);
    }
    for (const table of ["dashboards", "semantic_manifests", "schema_snapshots", "workspaces"]) {
      expect(await tableExists(table), `${table} survived rollback`).toBe(false);
    }
  });

  it("re-applies cleanly from an empty database", async () => {
    const { applied } = await migrateUp();
    expect(applied).toEqual(EXPECTED_ORDER);
    expect(await tableExists("fact_invoice")).toBe(true);
  });
});
