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
import { runSync, startSync } from "@/platform/sync/run";
import { claimJob, enqueueJob } from "@/platform/jobs/durable";
import { listHealth } from "@/platform/health";
import { closePool } from "@/platform/db/pool";
import type { WorkspaceContext } from "@/platform/contracts";

const ORG = "00000000-0000-4000-8000-00000000000c";
const WS = "00000000-0000-4000-8000-00000000001c";
const USER = "00000000-0000-4000-8000-0000000000c1";
const CONNECTION = "00000000-0000-4000-8000-0000000000c2";
const SNAPSHOT = "00000000-0000-4000-8000-0000000000c3";

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
  await pool.query(
    `INSERT INTO odoo_connections (id,workspace_id,base_url,database,login,status)
     VALUES ($1,$2,'https://gamma.odoo.test','gamma','c@c.test','connected')`,
    [CONNECTION, WS],
  );
  await pool.query(
    `INSERT INTO schema_snapshots (id,workspace_id,connection_id,content_hash,status)
     VALUES ($1,$2,$3,repeat('c',64),'ready')`,
    [SNAPSHOT, WS, CONNECTION],
  );
}, 120_000);

/** A published manifest, which is all `startSync` checks before enqueueing. */
async function publishManifest() {
  await pool.query(
    `INSERT INTO semantic_manifests (workspace_id, snapshot_id, version, status)
     VALUES ($1,$2,1,'published')`,
    [WS, SNAPSHOT],
  );
}

afterAll(async () => {
  await closePool().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

beforeEach(async () => {
  await pool.query("DELETE FROM data_health_states");
  await pool.query("DELETE FROM semantic_manifests");
  await pool.query("DELETE FROM job_queue");
});

describe("recovering from an abandoned refresh", () => {
  it("clears the dead job so the next refresh can be queued at all", async () => {
    await publishManifest();

    // A refresh claimed by a worker that then died, with its retries spent —
    // the state a deploy mid-sync leaves behind.
    const dead = await enqueueJob({ workspaceId: WS, kind: "sync", maxAttempts: 1 });
    await claimJob("worker-that-died", ["sync"]);
    await pool.query("UPDATE job_queue SET leased_until = now() - interval '1 hour'");

    const { jobId } = await startSync(context);

    const { rows } = await pool.query("SELECT id, status FROM job_queue ORDER BY created_at", []);
    const previous = rows.find((row) => row.id === dead.id);
    // The corpse is closed out, and the refresh the customer asked for is a
    // genuinely new job rather than a handle on the dead one.
    expect(previous?.status).toBe("failed");
    expect(jobId).not.toBe(dead.id);
    expect(rows.find((row) => row.id === jobId)?.status).toBe("queued");
  });
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
