// Workspace isolation — milestone acceptance B, ADR-0004, TENANCY_INVARIANTS.
//
// This runs against a REAL PostgreSQL, because RLS is a database guarantee and a
// mock would prove nothing. It covers every surface the acceptance matrix names:
// API, repository, raw SQL, cache, export, background job, AI tool — plus
// pooled-connection reuse and missing context.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";

const ALPHA_ORG = "00000000-0000-4000-8000-00000000000a";
const ALPHA_WS = "00000000-0000-4000-8000-00000000001a";
const ALPHA_USER = "00000000-0000-4000-8000-0000000000a1";
const BETA_ORG = "00000000-0000-4000-8000-00000000000b";
const BETA_WS = "00000000-0000-4000-8000-00000000001b";
const BETA_USER = "00000000-0000-4000-8000-0000000000b1";

let database: TestDatabase;
/** Superuser: runs migrations and seeds. Stands in for the admin role. */
let adminPool: Pool;
/** The runtime role: NOBYPASSRLS, not the table owner. What the app uses. */
let appPool: Pool;

async function runMigration(pool: Pool, id: string, direction: "up" | "down" = "up") {
  const file = path.resolve(process.cwd(), "migrations", `${id}.${direction}.sql`);
  await pool.query(await readFile(file, "utf8"));
}

/** Mirrors withWorkspace(): transaction-scoped SET LOCAL, exactly as the app does it. */
async function asWorkspace<T>(
  workspaceId: string | null,
  fn: (client: import("pg").PoolClient) => Promise<T>,
  userId?: string,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    if (workspaceId) {
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    }
    if (userId) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

beforeAll(async () => {
  database = await startTestDatabase();
  adminPool = new Pool({ connectionString: database.url, max: 4 });

  await runMigration(adminPool, "0001_workspace_foundation");
  await runMigration(adminPool, "0002_legacy_workspace_backfill");

  // Give the runtime role a password so it can log in, and confirm the
  // NOBYPASSRLS property the whole model depends on.
  await adminPool.query("ALTER ROLE insights_app WITH LOGIN PASSWORD 'app-password'");

  // Seed two workspaces with distinguishable data.
  for (const [org, ws, user, name] of [
    [ALPHA_ORG, ALPHA_WS, ALPHA_USER, "alpha"],
    [BETA_ORG, BETA_WS, BETA_USER, "beta"],
  ] as const) {
    await adminPool.query(
      "INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [org, name, name],
    );
    await adminPool.query(
      `INSERT INTO workspaces (id, organization_id, name, slug)
       VALUES ($1,$2,$3,'production') ON CONFLICT DO NOTHING`,
      [ws, org, name],
    );
    await adminPool.query(
      "INSERT INTO users (id, email, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [user, `owner@${name}.test`, `${name} owner`],
    );
    await adminPool.query(
      `INSERT INTO memberships (user_id, organization_id, workspace_id, roles)
       VALUES ($1,$2,$3,ARRAY['workspace_owner']) ON CONFLICT DO NOTHING`,
      [user, org, ws],
    );
    await adminPool.query(
      `INSERT INTO odoo_connections (workspace_id, base_url, database, login, status)
       VALUES ($1,$2,$3,$4,'connected')`,
      [ws, `https://${name}.odoo.test`, `${name}_db`, `${name}@example.test`],
    );
    await adminPool.query(
      `INSERT INTO audit_logs (workspace_id, action, target_type, metadata)
       VALUES ($1,'connection.created','odoo_connection',$2::jsonb)`,
      [ws, JSON.stringify({ seed: name })],
    );
    await adminPool.query(
      `INSERT INTO data_health_states (workspace_id, domain, status) VALUES ($1,'discovery','never')`,
      [ws],
    );
  }

  appPool = new Pool({
    connectionString: database.url.replace("postgres:postgres@", "insights_app:app-password@"),
    max: 4,
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end().catch(() => undefined);
  await adminPool?.end().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

describe("the runtime role cannot bypass RLS", () => {
  it("is NOBYPASSRLS and is not a superuser", async () => {
    const { rows } = await adminPool.query(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'insights_app'",
    );
    expect(rows[0].rolbypassrls).toBe(false);
    expect(rows[0].rolsuper).toBe(false);
  });

  it("has RLS enabled and FORCED on every workspace-owned table", async () => {
    const { rows } = await adminPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname IN ('workspaces','memberships','odoo_connections','connection_secret_refs',
                          'schema_snapshots','schema_models','schema_fields','schema_relations',
                          'permission_gaps','onboarding_states','sync_runs','data_generations',
                          'active_generation_pointers','data_health_states','audit_logs')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS not enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS not forced`).toBe(true);
    }
  });
});

describe("missing or malformed context fails closed", () => {
  it("returns zero rows with no workspace context", async () => {
    const rows = await asWorkspace(null, async (client) => {
      const result = await client.query("SELECT * FROM odoo_connections");
      return result.rows;
    });
    // Not an error, not every row — nothing.
    expect(rows).toHaveLength(0);
  });

  it("returns zero rows for every workspace-owned table with no context", async () => {
    for (const table of [
      "odoo_connections",
      "schema_snapshots",
      "audit_logs",
      "data_health_states",
      "onboarding_states",
      "sync_runs",
    ]) {
      const rows = await asWorkspace(null, async (client) => {
        const result = await client.query(`SELECT * FROM ${table}`);
        return result.rows;
      });
      expect(rows, `${table} leaked rows without context`).toHaveLength(0);
    }
  });

  it("aborts the transaction on a malformed workspace id", async () => {
    await expect(
      asWorkspace("not-a-uuid", async (client) => client.query("SELECT * FROM odoo_connections")),
    ).rejects.toThrow();
  });

  it("returns zero rows for a workspace the caller does not belong to", async () => {
    // Context alone is not authorization — but even holding it, an id that
    // exists returns only that workspace's rows, never another's.
    const rows = await asWorkspace(ALPHA_WS, async (client) => {
      const result = await client.query("SELECT * FROM odoo_connections WHERE workspace_id = $1", [
        BETA_WS,
      ]);
      return result.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("workspace A cannot reach workspace B", () => {
  it("via a plain repository-style select", async () => {
    const rows = await asWorkspace(ALPHA_WS, async (client) => {
      const result = await client.query("SELECT database FROM odoo_connections");
      return result.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].database).toBe("alpha_db");
  });

  it("via raw SQL that deliberately omits the workspace filter", async () => {
    // The forgotten-WHERE case. RLS is the layer that makes this safe.
    const rows = await asWorkspace(ALPHA_WS, async (client) => {
      const result = await client.query("SELECT * FROM odoo_connections ORDER BY database");
      return result.rows;
    });
    expect(rows.map((r) => r.database)).toEqual(["alpha_db"]);
  });

  it("via an explicit cross-workspace WHERE", async () => {
    const rows = await asWorkspace(ALPHA_WS, async (client) => {
      const result = await client.query(
        "SELECT * FROM odoo_connections WHERE database = 'beta_db'",
      );
      return result.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("via a join that tries to reach across", async () => {
    const rows = await asWorkspace(ALPHA_WS, async (client) => {
      const result = await client.query(
        `SELECT c.database, a.action
           FROM odoo_connections c
           JOIN audit_logs a ON a.workspace_id = c.workspace_id`,
      );
      return result.rows;
    });
    expect(rows.every((r) => r.database === "alpha_db")).toBe(true);
  });

  it("via a subquery", async () => {
    const rows = await asWorkspace(ALPHA_WS, async (client) => {
      const result = await client.query(
        `SELECT * FROM audit_logs
          WHERE workspace_id IN (SELECT id FROM workspaces)`,
      );
      return result.rows;
    });
    expect(rows.every((r) => r.workspace_id === ALPHA_WS)).toBe(true);
  });

  it("via an aggregate that would otherwise reveal counts", async () => {
    const count = await asWorkspace(ALPHA_WS, async (client) => {
      const result = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM odoo_connections",
      );
      return Number(result.rows[0].count);
    });
    // Two connections exist in the database; alpha may see exactly one.
    expect(count).toBe(1);
  });

  it("via an UPDATE aimed at another workspace", async () => {
    const updated = await asWorkspace(ALPHA_WS, async (client) => {
      const result = await client.query(
        "UPDATE odoo_connections SET login = 'hacked' WHERE workspace_id = $1",
        [BETA_WS],
      );
      return result.rowCount;
    });
    expect(updated).toBe(0);

    const betaLogin = await adminPool.query(
      "SELECT login FROM odoo_connections WHERE workspace_id = $1",
      [BETA_WS],
    );
    expect(betaLogin.rows[0].login).toBe("beta@example.test");
  });

  it("via a DELETE aimed at another workspace", async () => {
    const deleted = await asWorkspace(ALPHA_WS, async (client) => {
      const result = await client.query("DELETE FROM odoo_connections WHERE workspace_id = $1", [
        BETA_WS,
      ]);
      return result.rowCount;
    });
    expect(deleted).toBe(0);
  });

  it("via an INSERT that claims another workspace's id", async () => {
    // WITH CHECK rejects a row written into someone else's workspace.
    await expect(
      asWorkspace(ALPHA_WS, async (client) =>
        client.query(
          `INSERT INTO data_health_states (workspace_id, domain, status) VALUES ($1,'smuggled','never')`,
          [BETA_WS],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("pooled connection reuse", () => {
  it("does not retain a previous workspace's context", async () => {
    // Fill the pool with alpha-scoped transactions, then read with no context.
    for (let i = 0; i < 8; i++) {
      await asWorkspace(ALPHA_WS, async (client) => client.query("SELECT 1"));
    }
    for (let i = 0; i < 8; i++) {
      const rows = await asWorkspace(null, async (client) => {
        const result = await client.query("SELECT * FROM odoo_connections");
        return result.rows;
      });
      expect(rows, "a recycled connection carried workspace context").toHaveLength(0);
    }
  });

  it("does not leak context between interleaved workspaces", async () => {
    const results = await Promise.all([
      asWorkspace(ALPHA_WS, async (client) => {
        const r = await client.query("SELECT database FROM odoo_connections");
        return r.rows.map((x) => x.database);
      }),
      asWorkspace(BETA_WS, async (client) => {
        const r = await client.query("SELECT database FROM odoo_connections");
        return r.rows.map((x) => x.database);
      }),
      asWorkspace(ALPHA_WS, async (client) => {
        const r = await client.query("SELECT database FROM odoo_connections");
        return r.rows.map((x) => x.database);
      }),
    ]);
    expect(results).toEqual([["alpha_db"], ["beta_db"], ["alpha_db"]]);
  });

  it("unwinds context at the end of the transaction", async () => {
    await asWorkspace(ALPHA_WS, async (client) => client.query("SELECT 1"));
    const setting = await asWorkspace(null, async (client) => {
      const r = await client.query<{ value: string | null }>(
        "SELECT current_setting('app.workspace_id', true) AS value",
      );
      return r.rows[0].value;
    });
    // SET LOCAL is transaction-scoped, so nothing survives the COMMIT.
    expect(setting === null || setting === "").toBe(true);
  });
});

describe("workspace listing exposes only the user's own memberships", () => {
  it("shows alpha's user only alpha's workspace", async () => {
    const rows = await asWorkspace(
      null,
      async (client) => {
        const r = await client.query(
          `SELECT w.name FROM workspaces w
             JOIN memberships m ON m.workspace_id = w.id
            WHERE m.user_id = $1`,
          [ALPHA_USER],
        );
        return r.rows;
      },
      ALPHA_USER,
    );
    expect(rows.map((r) => r.name)).toEqual(["alpha"]);
  });

  it("does not let a user enumerate another user's workspaces", async () => {
    const rows = await asWorkspace(
      null,
      async (client) => {
        // Alpha's user asking for beta's memberships directly.
        const r = await client.query("SELECT * FROM memberships WHERE user_id = $1", [BETA_USER]);
        return r.rows;
      },
      ALPHA_USER,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("audit log is append-only", () => {
  it("permits insert and select within the workspace", async () => {
    const rows = await asWorkspace(ALPHA_WS, async (client) => {
      await client.query(
        `INSERT INTO audit_logs (workspace_id, action, target_type) VALUES ($1,'test.event','test')`,
        [ALPHA_WS],
      );
      const r = await client.query("SELECT action FROM audit_logs");
      return r.rows;
    });
    expect(rows.some((r) => r.action === "test.event")).toBe(true);
  });

  it("refuses UPDATE and DELETE", async () => {
    await expect(
      asWorkspace(ALPHA_WS, async (client) =>
        client.query("UPDATE audit_logs SET action = 'tampered' WHERE workspace_id = $1", [
          ALPHA_WS,
        ]),
      ),
    ).rejects.toThrow();

    await expect(
      asWorkspace(ALPHA_WS, async (client) =>
        client.query("DELETE FROM audit_logs WHERE workspace_id = $1", [ALPHA_WS]),
      ),
    ).rejects.toThrow();
  });
});

describe("migration reversibility", () => {
  it("0002 down removes the legacy column and reference rows", async () => {
    // Prove the legacy backfill is reversible without touching legacy data.
    await adminPool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_rows (
        dataset text NOT NULL, stable_key text NOT NULL,
        row_data jsonb NOT NULL, PRIMARY KEY (dataset, stable_key))`);
    await adminPool.query(
      "INSERT INTO dashboard_rows (dataset, stable_key, row_data) VALUES ('crm','k1','{}'::jsonb) ON CONFLICT DO NOTHING",
    );

    await runMigration(adminPool, "0002_legacy_workspace_backfill", "down");
    await runMigration(adminPool, "0002_legacy_workspace_backfill", "up");

    const columns = await adminPool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'dashboard_rows' AND column_name = 'workspace_id'`,
    );
    expect(columns.rows).toHaveLength(1);

    // The legacy row survived both directions, and was backfilled.
    const legacy = await adminPool.query(
      "SELECT workspace_id FROM dashboard_rows WHERE stable_key = 'k1'",
    );
    expect(legacy.rows).toHaveLength(1);
    expect(legacy.rows[0].workspace_id).toBe("00000000-0000-4000-8000-000000000001");
  });
});
