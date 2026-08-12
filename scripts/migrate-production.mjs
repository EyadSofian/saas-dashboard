// Production migration runner with no TypeScript loader dependency.
//
// The development runner imports TypeScript modules directly, which works
// through Vite/Vitest but not through plain Node's ESM resolver in Railway.
// Startup must be able to migrate before the application bundle is running,
// so this deliberately depends only on Node built-ins and `pg`.
import { createHash } from "node:crypto";
import console from "node:console";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const isInternal = connectionString.includes(".railway.internal");
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const pool = new pg.Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 15_000,
  ssl:
    isInternal || isLocal || process.env.PGSSLMODE === "disable"
      ? false
      : { rejectUnauthorized: false },
});

const migrationsDir = path.resolve(process.cwd(), "migrations");
const entries = await readdir(migrationsDir);
const ids = entries
  .filter((file) => file.endsWith(".up.sql"))
  .map((file) => file.replace(/\.up\.sql$/, ""))
  .sort();

const client = await pool.connect();
try {
  // One deployment migrates at a time. This remains safe if the service later
  // grows from one replica to several and they start concurrently.
  await client.query("SELECT pg_advisory_lock(739104221)");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const existing = await client.query("SELECT id, checksum FROM schema_migrations");
  const applied = new Map(existing.rows.map((row) => [row.id, row.checksum]));

  for (const id of ids) {
    const sql = await readFile(path.join(migrationsDir, `${id}.up.sql`), "utf8");
    const checksum = createHash("sha256").update(sql, "utf8").digest("hex").slice(0, 16);
    const recorded = applied.get(id);

    if (recorded) {
      if (recorded !== checksum) {
        throw new Error(
          `Migration ${id} was modified after being applied ` +
            `(recorded ${recorded}, found ${checksum}).`,
        );
      }
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [
        id,
        checksum,
      ]);
      await client.query("COMMIT");
      console.log(`Applied migration ${id}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  console.log(`Database schema ready (${ids.length} migrations).`);
} finally {
  await client.query("SELECT pg_advisory_unlock(739104221)").catch(() => undefined);
  client.release();
  await pool.end();
}
