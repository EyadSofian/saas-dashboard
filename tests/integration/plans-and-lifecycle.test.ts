// Entitlements, metering and workspace lifecycle, against a real PostgreSQL.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";
import { checkLimit, planFor, recordUsage, usageSince } from "@/platform/billing/entitlements";
import {
  cancelDeletion,
  exportWorkspace,
  executeDueDeletions,
  pendingDeletion,
  requestDeletion,
} from "@/platform/workspace/lifecycle";
import { closePool } from "@/platform/db/pool";
import type { WorkspaceContext } from "@/platform/contracts";

const ORG = "00000000-0000-4000-8000-00000000000a";
const WS = "00000000-0000-4000-8000-00000000001a";
const USER = "00000000-0000-4000-8000-0000000000a1";

const context: WorkspaceContext = {
  workspaceId: WS,
  organizationId: ORG,
  userId: USER,
  roles: ["workspace_owner"],
};

let database: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  database = await startTestDatabase();
  process.env.DATABASE_URL = database.url;
  pool = new Pool({ connectionString: database.url, max: 4 });

  for (const id of [
    "0001_foundation",
    "0002_schema_discovery",
    "0003_semantic_layer",
    "0004_canonical_and_dashboards",
    "0005_durable_jobs_and_watermarks",
    "0006_reconciliation",
    "0007_dashboard_builder",
    "0008_copilot",
    "0009_plans_and_lifecycle",
  ]) {
    await pool.query(
      await readFile(path.resolve(process.cwd(), "migrations", `${id}.up.sql`), "utf8"),
    );
  }

  await pool.query("INSERT INTO organizations (id,name,slug) VALUES ($1,'Alpha','alpha')", [ORG]);
  await pool.query("INSERT INTO users (id,email,name) VALUES ($1,'a@a.test','A')", [USER]);
  await pool.query(
    "INSERT INTO workspaces (id,organization_id,name,slug) VALUES ($1,$2,'Alpha','production')",
    [WS, ORG],
  );
  await pool.query(
    "INSERT INTO memberships (user_id,organization_id,workspace_id,roles) VALUES ($1,$2,$3,ARRAY['workspace_owner'])",
    [USER, ORG, WS],
  );
}, 120_000);

afterAll(async () => {
  await closePool().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

beforeEach(async () => {
  await pool.query("DELETE FROM usage_events");
  await pool.query("DELETE FROM deletion_requests");
  await pool.query("DELETE FROM odoo_connections");
  await pool.query(
    "INSERT INTO workspace_subscriptions (workspace_id, plan_key, status) VALUES ($1,'starter','active') ON CONFLICT (workspace_id) DO UPDATE SET plan_key='starter'",
    [WS],
  );
});

describe("plans", () => {
  it("defaults a workspace to Starter rather than to unlimited", async () => {
    await pool.query("DELETE FROM workspace_subscriptions WHERE workspace_id = $1", [WS]);
    const plan = await planFor(context);
    // An ambiguous plan must fail closed.
    expect(plan.key).toBe("starter");
    expect(plan.maxConnections).toBe(1);
  });

  it("never meters data correctness", async () => {
    // Every plan gets reconciliation, null discipline and explainability.
    // Only volume, frequency, seats and AI are tiered.
    const { rows } = await pool.query("SELECT * FROM plans");
    const columns = Object.keys(rows[0]);
    for (const forbidden of ["reconciliation", "accuracy", "explainability", "audit"]) {
      expect(columns.some((column) => column.includes(forbidden))).toBe(false);
    }
  });

  it("gives higher plans a faster sync floor", async () => {
    const { rows } = await pool.query(
      "SELECT key, min_sync_minutes FROM plans ORDER BY sort_order",
    );
    const intervals = rows.map((row) => Number(row.min_sync_minutes));
    expect(intervals[0]).toBeGreaterThan(intervals[intervals.length - 1]);
  });
});

describe("limits", () => {
  it("allows the first connection on Starter and refuses the second", async () => {
    const before = await checkLimit(context, "connections");
    expect(before.allowed).toBe(true);
    expect(before.limit).toBe(1);

    await pool.query(
      "INSERT INTO odoo_connections (workspace_id, base_url, database, login) VALUES ($1,'https://a.test','db','a')",
      [WS],
    );

    const after = await checkLimit(context, "connections");
    expect(after.allowed).toBe(false);
    // The reason is stated so the UI can explain rather than just disable.
    expect(after.reason).toContain("starter");
  });

  it("counts existing members against the seat limit", async () => {
    const check = await checkLimit(context, "members");
    expect(check.current).toBe(1);
    expect(check.allowed).toBe(true);
  });

  it("gates the copilot by plan", async () => {
    expect((await checkLimit(context, "copilot")).allowed).toBe(false);

    await pool.query("UPDATE workspace_subscriptions SET plan_key='growth' WHERE workspace_id=$1", [
      WS,
    ]);
    expect((await checkLimit(context, "copilot")).allowed).toBe(true);
  });

  it("treats an unlimited plan as unlimited", async () => {
    await pool.query(
      "UPDATE workspace_subscriptions SET plan_key='enterprise' WHERE workspace_id=$1",
      [WS],
    );
    const check = await checkLimit(context, "connections");
    expect(check.allowed).toBe(true);
    expect(check.limit).toBeNull();
  });

  it("fails closed on an unknown limit", async () => {
    const check = await checkLimit(context, "nonsense" as never);
    expect(check.allowed).toBe(false);
  });
});

describe("usage metering", () => {
  it("records and summarises usage", async () => {
    await recordUsage(context, "sync_run", 1);
    await recordUsage(context, "rows_synced", 4200);
    await recordUsage(context, "rows_synced", 800);

    const summary = await usageSince(context, new Date(Date.now() - 3_600_000));
    const rows = summary.find((entry) => entry.kind === "rows_synced");
    expect(rows?.total).toBe(5000);
    expect(rows?.events).toBe(2);
  });

  it("never lets a metering failure break the metered action", async () => {
    // Fire-and-forget by design: under-billing is a commercial problem, while
    // refusing a customer's sync because a usage insert failed is a product one.
    const broken: WorkspaceContext = { ...context, workspaceId: "not-a-uuid" };
    await expect(recordUsage(broken, "sync_run")).resolves.toBeUndefined();
  });
});

describe("export", () => {
  it("includes the workspace's own data", async () => {
    const dump = await exportWorkspace(context);
    expect(dump.workspace).toBeTruthy();
    expect(Array.isArray(dump.members)).toBe(true);
    expect(dump.format).toBe(1);
  });

  it("excludes Odoo credentials entirely", async () => {
    await pool.query(
      "INSERT INTO odoo_connections (id, workspace_id, base_url, database, login) VALUES ($1,$2,'https://a.test','db','a')",
      ["44444444-4444-4444-8444-444444444444", WS],
    );
    await pool.query(
      `INSERT INTO connection_secret_refs
         (workspace_id, connection_id, adapter_id, key_id, ciphertext, iv, auth_tag)
       VALUES ($1,$2,'local-aes-gcm','v1','SUPERSECRETCIPHERTEXT','iv','tag')`,
      [WS, "44444444-4444-4444-8444-444444444444"],
    );

    const serialized = JSON.stringify(await exportWorkspace(context));
    // An export travels by email and sits in a downloads folder. A customer's
    // ERP key does not belong in one.
    expect(serialized).not.toContain("SUPERSECRETCIPHERTEXT");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).toContain("deliberately excluded");
  });
});

describe("deletion", () => {
  it("schedules rather than deleting immediately", async () => {
    const request = await requestDeletion(context, "no longer needed");
    expect(request.status).toBe("scheduled");
    // A grace period, so changing your mind on Monday still works.
    expect(Date.parse(request.executeAfter)).toBeGreaterThan(Date.now());

    const { rows } = await pool.query("SELECT 1 FROM workspaces WHERE id = $1", [WS]);
    expect(rows).toHaveLength(1);
  });

  it("can be cancelled during the grace period", async () => {
    await requestDeletion(context, "changed my mind later");
    expect(await cancelDeletion(context)).toBe(true);
    expect(await pendingDeletion(context)).toBeNull();
  });

  it("does not execute before the grace period elapses", async () => {
    await requestDeletion(context, "later");
    expect(await executeDueDeletions()).toEqual([]);

    const { rows } = await pool.query("SELECT 1 FROM workspaces WHERE id = $1", [WS]);
    expect(rows).toHaveLength(1);
  });

  it("executes once due, removing every owned row by cascade", async () => {
    await requestDeletion(context, "done");
    await pool.query("UPDATE deletion_requests SET execute_after = now() - interval '1 day'");

    const deleted = await executeDueDeletions();
    expect(deleted).toContain(WS);

    // Relying on ON DELETE CASCADE rather than an enumerated table list, which
    // would silently go stale the next time a migration adds one.
    for (const table of ["memberships", "odoo_connections", "usage_events", "dashboards"]) {
      const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE workspace_id = $1`, [WS]);
      expect(rows, `${table} still holds rows`).toHaveLength(0);
    }
  });
});
