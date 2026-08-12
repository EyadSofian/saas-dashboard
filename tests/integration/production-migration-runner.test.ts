import { readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";

const execFileAsync = promisify(execFile);
let database: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = new Pool({ connectionString: database.url });
}, 120_000);

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

// Counted from disk rather than hardcoded: a test that has to be edited every
// time a migration is added stops being a check and becomes a chore.
const MIGRATION_COUNT = readdirSync("migrations").filter((f) => f.endsWith(".up.sql")).length;

describe("production migration runner", () => {
  it("applies the full schema under plain Node and is idempotent", async () => {
    const env = { ...process.env, DATABASE_URL: database.url };
    const first = await execFileAsync(process.execPath, ["scripts/migrate-production.mjs"], {
      env,
    });
    expect(first.stdout).toContain(`Database schema ready (${MIGRATION_COUNT} migrations)`);

    const second = await execFileAsync(process.execPath, ["scripts/migrate-production.mjs"], {
      env,
    });
    expect(second.stdout).toContain(`Database schema ready (${MIGRATION_COUNT} migrations)`);

    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schema_migrations",
    );
    expect(result.rows[0]?.count).toBe(String(MIGRATION_COUNT));
  });
});
