// Durable jobs and incremental sync state, against a real PostgreSQL.
//
// The properties under test are exactly the ones the in-process runner could
// not offer: surviving a restart, being claimable by another worker, and not
// handing one job to two workers at once.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  heartbeatJob,
  JobWorker,
  stalledJobs,
} from "@/platform/jobs/durable";
import {
  commitWatermark,
  incrementalDomain,
  needsFullSync,
  readWatermarks,
} from "@/platform/sync/incremental";
import { closePool } from "@/platform/db/pool";
import type { WorkspaceContext } from "@/platform/contracts";

const WS = "00000000-0000-4000-8000-00000000001a";
const ORG = "00000000-0000-4000-8000-00000000000a";

let database: TestDatabase;
let pool: Pool;

const context: WorkspaceContext = {
  workspaceId: WS,
  organizationId: ORG,
  userId: "00000000-0000-4000-8000-0000000000a1",
  roles: ["workspace_owner"],
};

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

  await pool.query("INSERT INTO organizations (id,name,slug) VALUES ($1,'Alpha','alpha')", [ORG]);
  await pool.query(
    "INSERT INTO workspaces (id,organization_id,name,slug) VALUES ($1,$2,'Alpha','production')",
    [WS, ORG],
  );
}, 120_000);

afterAll(async () => {
  await closePool().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

beforeEach(async () => {
  await pool.query("DELETE FROM job_queue");
  await pool.query("DELETE FROM sync_watermarks");
});

describe("enqueue", () => {
  it("adds a job", async () => {
    const result = await enqueueJob({ workspaceId: WS, kind: "sync" });
    expect(result.created).toBe(true);
    expect(result.id).toBeTruthy();
  });

  it("refuses a second live job of the same kind for the same workspace", async () => {
    // A schedule firing while someone clicks refresh must not scan one Odoo twice.
    const first = await enqueueJob({ workspaceId: WS, kind: "sync" });
    const second = await enqueueJob({ workspaceId: WS, kind: "sync" });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("allows a new job once the previous one finished", async () => {
    const first = await enqueueJob({ workspaceId: WS, kind: "sync" });
    await completeJob(first.id);
    const second = await enqueueJob({ workspaceId: WS, kind: "sync" });
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
  });

  it("allows different kinds concurrently", async () => {
    await enqueueJob({ workspaceId: WS, kind: "sync" });
    const discovery = await enqueueJob({ workspaceId: WS, kind: "discovery" });
    expect(discovery.created).toBe(true);
  });

  it("does not run a job scheduled for the future", async () => {
    await enqueueJob({
      workspaceId: WS,
      kind: "sync",
      runAfter: new Date(Date.now() + 3_600_000),
    });
    expect(await claimJob("worker-1", ["sync"])).toBeNull();
  });
});

describe("claiming", () => {
  it("hands a job to exactly one worker", async () => {
    await enqueueJob({ workspaceId: WS, kind: "sync" });

    // Two workers racing for the same queue head.
    const [a, b] = await Promise.all([
      claimJob("worker-a", ["sync"]),
      claimJob("worker-b", ["sync"]),
    ]);
    const claimed = [a, b].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });

  it("does not claim a job of an unrequested kind", async () => {
    await enqueueJob({ workspaceId: WS, kind: "discovery" });
    expect(await claimJob("worker-a", ["sync"])).toBeNull();
  });

  it("carries the checkpoint to whoever claims it", async () => {
    const job = await enqueueJob({ workspaceId: WS, kind: "sync" });
    await pool.query("UPDATE job_queue SET checkpoint = $1::jsonb WHERE id = $2", [
      JSON.stringify({ completedEntities: ["invoice"] }),
      job.id,
    ]);
    const claimed = await claimJob("worker-a", ["sync"]);
    expect(claimed?.checkpoint).toEqual({ completedEntities: ["invoice"] });
  });
});

describe("lease expiry — surviving a dead worker", () => {
  it("lets another worker resume a job whose lease expired", async () => {
    const job = await enqueueJob({ workspaceId: WS, kind: "sync" });
    const first = await claimJob("worker-a", ["sync"]);
    expect(first?.id).toBe(job.id);

    // While the lease holds, nobody else can take it.
    expect(await claimJob("worker-b", ["sync"])).toBeNull();

    // worker-a dies: its lease expires rather than stranding the job.
    await pool.query("UPDATE job_queue SET leased_until = now() - interval '1 minute'");

    const second = await claimJob("worker-b", ["sync"]);
    expect(second?.id).toBe(job.id);
    // The attempt counter advanced, so a job that keeps killing workers
    // eventually exhausts its budget rather than looping forever.
    expect(second?.attempts).toBe(2);
  });

  it("reports stalled jobs so a stuck queue is visible", async () => {
    await enqueueJob({ workspaceId: WS, kind: "sync" });
    await claimJob("worker-a", ["sync"]);
    expect(await stalledJobs()).toBe(0);

    await pool.query("UPDATE job_queue SET leased_until = now() - interval '1 minute'");
    expect(await stalledJobs()).toBe(1);
  });

  it("extends the lease on heartbeat", async () => {
    await enqueueJob({ workspaceId: WS, kind: "sync" });
    const job = await claimJob("worker-a", ["sync"]);
    await pool.query("UPDATE job_queue SET leased_until = now() + interval '1 second'");
    await heartbeatJob(job!.id, "worker-a");

    // A long step no longer risks having its job stolen mid-flight.
    expect(await claimJob("worker-b", ["sync"])).toBeNull();
  });

  it("ignores a heartbeat from a worker that no longer holds the lease", async () => {
    await enqueueJob({ workspaceId: WS, kind: "sync" });
    const job = await claimJob("worker-a", ["sync"]);
    await heartbeatJob(job!.id, "worker-impostor");

    const { rows } = await pool.query("SELECT leased_by FROM job_queue WHERE id = $1", [job!.id]);
    expect(rows[0].leased_by).toBe("worker-a");
  });
});

describe("failure and retry", () => {
  it("retries with backoff until the budget is exhausted", async () => {
    const job = await enqueueJob({ workspaceId: WS, kind: "sync", maxAttempts: 2 });

    await claimJob("worker-a", ["sync"]);
    expect(await failJob(job.id, new Error("odoo timeout"))).toBe("retrying");

    const { rows } = await pool.query("SELECT status, run_after FROM job_queue WHERE id=$1", [
      job.id,
    ]);
    expect(rows[0].status).toBe("queued");
    // Backed off, so a transient outage is not hammered.
    expect(new Date(rows[0].run_after).getTime()).toBeGreaterThan(Date.now());

    await pool.query("UPDATE job_queue SET run_after = now()");
    await claimJob("worker-a", ["sync"]);
    expect(await failJob(job.id, new Error("odoo timeout"))).toBe("failed");
  });

  it("keeps the checkpoint across a retry", async () => {
    const job = await enqueueJob({ workspaceId: WS, kind: "sync", maxAttempts: 3 });
    await claimJob("worker-a", ["sync"]);
    await pool.query("UPDATE job_queue SET checkpoint = $1::jsonb WHERE id=$2", [
      JSON.stringify({ done: ["invoice"] }),
      job.id,
    ]);
    await failJob(job.id, new Error("boom"));

    const { rows } = await pool.query("SELECT checkpoint FROM job_queue WHERE id=$1", [job.id]);
    // Work already done is not repeated — the point of checkpointing.
    expect(rows[0].checkpoint).toEqual({ done: ["invoice"] });
  });

  it("redacts nothing sensitive into the stored error", async () => {
    const job = await enqueueJob({ workspaceId: WS, kind: "sync" });
    await claimJob("worker-a", ["sync"]);
    await failJob(job.id, new Error("failed\nsecond line with internals"));

    const { rows } = await pool.query("SELECT error FROM job_queue WHERE id=$1", [job.id]);
    expect(rows[0].error).toBe("failed");
  });
});

describe("worker loop", () => {
  it("runs a handler and marks the job succeeded", async () => {
    await enqueueJob({ workspaceId: WS, kind: "sync" });
    let ran = false;

    const worker = new JobWorker({
      kinds: ["sync"],
      handlers: {
        sync: async ({ context: jobContext }) => {
          ran = true;
          expect(jobContext.workspaceId).toBe(WS);
        },
      },
    });

    expect(await worker.tick()).toBe(true);
    expect(ran).toBe(true);

    const { rows } = await pool.query("SELECT status FROM job_queue");
    expect(rows[0].status).toBe("succeeded");
  });

  it("marks a job failed when its handler throws", async () => {
    await enqueueJob({ workspaceId: WS, kind: "sync", maxAttempts: 1 });
    const worker = new JobWorker({
      kinds: ["sync"],
      handlers: {
        sync: async () => {
          throw new Error("handler exploded");
        },
      },
    });

    await worker.tick();
    const { rows } = await pool.query("SELECT status, error FROM job_queue");
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("handler exploded");
  });

  it("fails a job with no registered handler instead of looping on it", async () => {
    await enqueueJob({ workspaceId: WS, kind: "sync", maxAttempts: 1 });
    const worker = new JobWorker({ kinds: ["sync"], handlers: {} });
    await worker.tick();

    const { rows } = await pool.query("SELECT status, error FROM job_queue");
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("No handler registered");
  });

  it("reports no work when the queue is empty", async () => {
    const worker = new JobWorker({ kinds: ["sync"], handlers: { sync: async () => {} } });
    expect(await worker.tick()).toBe(false);
  });
});

describe("watermarks", () => {
  it("round-trips a composite watermark", async () => {
    await commitWatermark(context, "invoice", "2026-03-05T09:00:00.000Z", 4821, false);
    const marks = await readWatermarks(context);
    expect(marks.get("invoice")?.lastSourceId).toBe(4821);
    expect(marks.get("invoice")?.lastWriteDate).toBe("2026-03-05T09:00:00.000Z");
  });

  it("preserves the last full sync time across incremental commits", async () => {
    await commitWatermark(context, "invoice", "2026-03-01T00:00:00.000Z", 1, true);
    await commitWatermark(context, "invoice", "2026-03-05T00:00:00.000Z", 99, false);

    const marks = await readWatermarks(context);
    // An incremental run must not erase the record of when the last full pass
    // happened, or the periodic full sync would never fire again.
    expect(marks.get("invoice")?.lastFullSyncAt).not.toBeNull();
    expect(marks.get("invoice")?.lastSourceId).toBe(99);
  });

  it("re-reads a small overlap so a boundary second cannot be lost", () => {
    const plan = {
      entity: "invoice" as const,
      odooModel: "account.move",
      fields: [],
      columns: {},
      target: "fact_invoice",
      domain: [["state", "=", "posted"]],
    };
    const domain = incrementalDomain(plan, {
      entity: "invoice",
      lastWriteDate: "2026-03-05T09:00:00.000Z",
      lastSourceId: 10,
      lastFullSyncAt: null,
    }) as Array<[string, string, string]>;

    const clause = domain.find((entry) => entry[0] === "write_date");
    expect(clause?.[1]).toBe(">=");
    // A minute earlier than the watermark: upserts are idempotent, so
    // re-reading is free and closes the same-second window.
    expect(clause?.[2]).toBe("2026-03-05 08:59:00");
    // The approved domain is preserved, never replaced.
    expect(domain[0]).toEqual(["state", "=", "posted"]);
  });

  it("reads everything when there is no watermark yet", () => {
    const plan = {
      entity: "invoice" as const,
      odooModel: "account.move",
      fields: [],
      columns: {},
      target: "fact_invoice",
      domain: [],
    };
    expect(incrementalDomain(plan, undefined)).toEqual([]);
  });

  it("forces a full sync when none has run or the last is stale", () => {
    expect(needsFullSync(undefined)).toBe(true);
    expect(
      needsFullSync({
        entity: "invoice",
        lastWriteDate: null,
        lastSourceId: null,
        lastFullSyncAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      }),
    ).toBe(true);
    expect(
      needsFullSync({
        entity: "invoice",
        lastWriteDate: null,
        lastSourceId: null,
        lastFullSyncAt: new Date().toISOString(),
      }),
    ).toBe(false);
  });
});
