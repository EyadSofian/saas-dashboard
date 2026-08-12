// A refused sync has to leave a trace.
//
// The failures that strand a first-time customer all happen before a single row
// is read: nothing published, nothing approved, no connection, an unreadable
// credential. Those refusals used to be thrown before health was ever touched,
// so the Data health page stayed empty and the dashboard could only report that
// data had never synced — the symptom, never the cause.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";
import { runSync } from "@/platform/sync/run";
import { listHealth } from "@/platform/health";
import { closePool } from "@/platform/db/pool";
import type { WorkspaceContext } from "@/platform/contracts";

const ORG = "00000000-0000-4000-8000-00000000000c";
const WS = "00000000-0000-4000-8000-00000000001c";
const USER = "00000000-0000-4000-8000-0000000000c1";

const context: WorkspaceContext = {
  workspaceId: WS,
  organizationId: ORG,
  userId: USER,
  roles: ["workspace_owner"],
};

/** The callbacks the worker would supply, with the heartbeat counted. */
function jobCallbacks() {
  let heartbeats = 0;
  return {
    beats: () => heartbeats,
    callbacks: {
      signal: new AbortController().signal,
      checkpoint: async () => undefined,
      heartbeat: async () => {
        heartbeats += 1;
      },
    },
  };
}

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
  ]) {
    await pool.query(
      await readFile(path.resolve(process.cwd(), "migrations", `${id}.up.sql`), "utf8"),
    );
  }

  await pool.query("INSERT INTO organizations (id,name,slug) VALUES ($1,'Gamma','gamma')", [ORG]);
  await pool.query("INSERT INTO users (id,email,name) VALUES ($1,'c@c.test','C')", [USER]);
  await pool.query(
    "INSERT INTO workspaces (id,organization_id,name,slug) VALUES ($1,$2,'Gamma','production')",
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
  await pool.query("DELETE FROM data_health_states");
  await pool.query("DELETE FROM semantic_manifests");
});

describe("a refused sync", () => {
  it("records the reason on Data health instead of failing silently", async () => {
    const { callbacks } = jobCallbacks();

    await expect(runSync(context, callbacks)).rejects.toThrow(
      /Publish an approved mapping before syncing/,
    );

    const sync = (await listHealth(context)).find((row) => row.domain === "sync");
    // Without this the page has no row at all, and the only thing the product
    // can say is "never synced" — which is what the customer already knows.
    expect(sync).toBeDefined();
    expect(sync?.status).toBe("failed");
    expect(sync?.lastError).toMatch(/Publish an approved mapping before syncing/);
  });

  it("records an attempt even when it is turned away immediately", async () => {
    const { callbacks } = jobCallbacks();
    await expect(runSync(context, callbacks)).rejects.toThrow();

    const sync = (await listHealth(context)).find((row) => row.domain === "sync");
    expect(sync).toBeDefined();
    expect(sync!.lastAttemptAt).not.toBeNull();
    // Nothing succeeded, so freshness must not have moved.
    expect(sync!.lastSuccessAt).toBeNull();
  });
});
