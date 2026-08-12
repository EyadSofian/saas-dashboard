// A real PostgreSQL for the isolation and RLS tests.
//
// RLS cannot be tested against a mock: the whole point is that the DATABASE
// enforces isolation. `embedded-postgres` runs a genuine server from a dev
// dependency, so the tests exercise real policies, a real NOBYPASSRLS role and
// real transaction-scoped SET LOCAL — without requiring a system install.
//
// The cluster is created in a temp directory and destroyed afterwards. It never
// touches any configured production database.
import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TestDatabase {
  url: string;
  stop: () => Promise<void>;
}

let started: TestDatabase | null = null;

/** Picks a high port to avoid colliding with anything the developer is running. */
function pickPort(): number {
  return 55_000 + Math.floor(Math.random() * 5_000);
}

export async function startTestDatabase(): Promise<TestDatabase> {
  if (started) return started;

  const dataDir = await mkdtemp(path.join(tmpdir(), "insights-pg-"));
  const port = pickPort();
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("insights_test");

  started = {
    url: `postgresql://postgres:postgres@localhost:${port}/insights_test`,
    stop: async () => {
      started = null;
      try {
        await pg.stop();
      } finally {
        await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
  return started;
}
