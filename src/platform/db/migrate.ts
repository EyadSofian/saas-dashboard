// Ordered, reversible SQL migrations.
//
// Replaces the runtime `CREATE TABLE IF NOT EXISTS` pattern found by the audit
// (§4.6), which had no ordering, no version record and no down path. Multi-tenant
// tables with RLS cannot be managed that way.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withAdmin } from "./pool";

export interface Migration {
  id: string; // "0001_workspace_foundation"
  up: string;
  down: string;
  checksum: string;
}

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const ids = [
    ...new Set(
      entries.filter((f) => f.endsWith(".up.sql")).map((f) => f.replace(/\.up\.sql$/, "")),
    ),
  ].sort();

  return Promise.all(
    ids.map(async (id) => {
      const up = await readFile(path.join(dir, `${id}.up.sql`), "utf8");
      const down = await readFile(path.join(dir, `${id}.down.sql`), "utf8").catch(() => "");
      return {
        id,
        up,
        down,
        checksum: createHash("sha256").update(up, "utf8").digest("hex").slice(0, 16),
      };
    }),
  );
}

async function ensureMigrationsTable(): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });
}

export async function appliedMigrations(): Promise<Map<string, string>> {
  await ensureMigrationsTable();
  return withAdmin(async (client) => {
    const { rows } = await client.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM schema_migrations ORDER BY id",
    );
    return new Map(rows.map((r) => [r.id, r.checksum]));
  });
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending migrations in order. Each runs in its own transaction, so a
 * failure leaves earlier migrations applied and the failing one fully rolled
 * back rather than half-written.
 */
export async function migrateUp(dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const migrations = await loadMigrations(dir);
  const already = await appliedMigrations();
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    const previous = already.get(migration.id);
    if (previous) {
      // A changed checksum means an applied migration was edited in place —
      // which silently desynchronises environments. Refuse rather than guess.
      if (previous !== migration.checksum) {
        throw new Error(
          `Migration ${migration.id} was modified after being applied ` +
            `(recorded ${previous}, found ${migration.checksum}). ` +
            `Add a new migration instead of editing an applied one.`,
        );
      }
      skipped.push(migration.id);
      continue;
    }
    await withAdmin(async (client) => {
      await client.query(migration.up);
      await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [
        migration.id,
        migration.checksum,
      ]);
    });
    applied.push(migration.id);
  }
  return { applied, skipped };
}

/** Rolls back the most recently applied migration. */
export async function migrateDown(dir = MIGRATIONS_DIR): Promise<string | null> {
  const migrations = await loadMigrations(dir);
  const already = await appliedMigrations();
  const last = [...already.keys()].sort().pop();
  if (!last) return null;

  const migration = migrations.find((m) => m.id === last);
  if (!migration?.down.trim()) {
    throw new Error(`Migration ${last} has no down script; refusing to roll back.`);
  }
  await withAdmin(async (client) => {
    await client.query(migration.down);
    await client.query("DELETE FROM schema_migrations WHERE id = $1", [last]);
  });
  return last;
}
