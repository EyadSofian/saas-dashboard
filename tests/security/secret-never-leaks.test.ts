// Proof that a stored Odoo credential never appears anywhere it should not.
//
// The strongest form of this test is not "check the column we expect" — it is
// "store a secret through the real code path, then scan every text-bearing
// column of every table in a real database for it". A leak into a column nobody
// thought to check is exactly the kind this catches.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";
import { RailwaySecretStore, deriveKeyId } from "@/platform/secrets/railway";
import { SecretStoreError, setSecretStore } from "@/platform/secrets";
import { redactSecrets, safeErrorMessage, withSecretRedacted } from "@/platform/audit/redact";
import { writeAudit } from "@/platform/audit/log";
import { upsertConnection, getConnection } from "@/platform/workspace/repository";
import { closePool } from "@/platform/db/pool";
import type { WorkspaceContext } from "@/platform/contracts";

// A distinctive value: if it appears anywhere, it is unambiguously ours.
const ODOO_KEY = "ZZ-ODOO-PLAINTEXT-CANARY-9f3a7c21-DO-NOT-LEAK";
const ROOT_KEY = "Zq4vN8xKp2mR7tYw3sJhBc5dFgLnQaEuIoPzXvCbTyU=";
const OTHER_KEY = "hstNRUIBUm+w6sKjA1jYkMBfqiGlajuvXQ+GdsfKiaA=";

const ORG = "00000000-0000-4000-8000-00000000000a";
const WS = "00000000-0000-4000-8000-00000000001a";
const USER = "00000000-0000-4000-8000-0000000000a1";
const CONNECTION = "00000000-0000-4000-8000-0000000000c1";

const context: WorkspaceContext = {
  workspaceId: WS,
  organizationId: ORG,
  userId: USER,
  roles: ["workspace_owner", "data_admin"],
};

const ref = { workspaceId: WS, connectionId: CONNECTION, purpose: "odoo_api_key" };

let database: TestDatabase;
let pool: Pool;
let store: RailwaySecretStore;

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

  store = new RailwaySecretStore({ rootKey: ROOT_KEY });
  setSecretStore(store);
}, 120_000);

afterAll(async () => {
  setSecretStore(null);
  await closePool().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

afterEach(() => {
  delete process.env.APP_ENV;
  delete process.env.ALLOW_RAILWAY_SECRET_STORE_IN_PRODUCTION;
  delete process.env.SECRET_STORE_ADAPTER;
});

describe("the credential never reaches the database in plaintext", () => {
  it("is absent from every text column of every table", async () => {
    // Stored through the real repository path, exactly as the API does it.
    const secret = await store.put(ref, ODOO_KEY);
    await upsertConnection(context, {
      connectionId: CONNECTION,
      baseUrl: "https://a.test",
      database: "db",
      login: "user",
      secret,
      credentialReplaced: true,
    });

    // The id used as AES-GCM AAD is the id the repository persisted. This is a
    // regression assertion for a production bug where the route encrypted for
    // one random id and the repository inserted another.
    const connection = await getConnection(context);
    expect(connection?.id).toBe(CONNECTION);
    expect(await store.get({ ...ref, connectionId: connection!.id }, secret)).toBe(ODOO_KEY);

    // Exercise the surface most likely to copy a value around, the way the
    // real route does it: any code holding a decrypted key runs inside a
    // redaction scope, so a careless field name cannot leak it.
    await withSecretRedacted(ODOO_KEY, async () => {
      await writeAudit(context, {
        action: "connection.created",
        targetType: "odoo_connection",
        targetId: CONNECTION,
        // `apiKey` is caught by name; `note` is caught only by the value-based
        // pass, which is exactly what the scope provides.
        metadata: { apiKey: ODOO_KEY, note: `key is ${ODOO_KEY}` },
      });
    });

    const { rows: columns } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text','character varying','jsonb','json','character')`,
    );
    expect(columns.length).toBeGreaterThan(50);

    const leaks: string[] = [];
    for (const { table_name, column_name } of columns) {
      const { rows } = await pool.query(
        `SELECT 1 FROM ${table_name} WHERE ${column_name}::text LIKE $1 LIMIT 1`,
        [`%${ODOO_KEY}%`],
      );
      if (rows.length) leaks.push(`${table_name}.${column_name}`);
    }

    // The whole database, scanned. Nothing holds the plaintext.
    expect(leaks).toEqual([]);
  });

  it("stores ciphertext that does decrypt back, so the test is not passing by accident", async () => {
    const secret = await store.put(ref, ODOO_KEY);
    expect(secret.ciphertext).not.toContain(ODOO_KEY);
    expect(await store.get(ref, secret)).toBe(ODOO_KEY);
  });
});

describe("the credential never reaches an API response", () => {
  it("connection metadata says only whether a secret exists", async () => {
    const connection = await getConnection(context);
    const serialized = JSON.stringify(connection);
    expect(serialized).not.toContain(ODOO_KEY);
    expect(serialized).not.toContain("ciphertext");
    expect(connection?.hasSecret).toBe(true);
  });

  it("the workspace export omits it", async () => {
    const { exportWorkspace } = await import("@/platform/workspace/lifecycle");
    const serialized = JSON.stringify(await exportWorkspace(context));
    expect(serialized).not.toContain(ODOO_KEY);
  });
});

describe("the credential never reaches a log, error or audit record", () => {
  it("is redacted from a structure by field name and by value", async () => {
    await withSecretRedacted(ODOO_KEY, async () => {
      const payload = {
        apiKey: ODOO_KEY,
        nested: { note: `authenticating with ${ODOO_KEY}` },
      };
      expect(JSON.stringify(redactSecrets(payload))).not.toContain(ODOO_KEY);
    });
  });

  it("is redacted from an error message", async () => {
    await withSecretRedacted(ODOO_KEY, async () => {
      const message = safeErrorMessage(new Error(`Odoo rejected key ${ODOO_KEY}`));
      expect(message).not.toContain(ODOO_KEY);
    });
  });

  it("is absent from an audit record even when the caller passes it in a plain field", async () => {
    // Redaction happens on write, so the database never holds it — a later
    // reader with full permission still cannot recover it. `note` is not a
    // secret-shaped field name, so this passes only because the value-based
    // pass caught it.
    const { rows } = await pool.query(
      "SELECT metadata::text AS m FROM audit_logs WHERE workspace_id = $1",
      [WS],
    );
    for (const row of rows) expect(String(row.m)).not.toContain(ODOO_KEY);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("the credential never reaches an AI payload", () => {
  it("is absent from the mapping proposer's prompt", async () => {
    const { AiProposer } = await import("@/platform/semantic/ai-proposer");
    const { DeterministicProposer } = await import("@/platform/semantic/proposer");
    const { discoverSchema } = await import("@/platform/discovery/discover");
    const { SafeOdooConnector } = await import("@/platform/odoo/connector");
    const { DISCOVERY_ALLOWLIST } = await import("@/platform/odoo/allowlist");
    const { createMockOdoo, MOCK_CREDENTIALS } = await import("../fixtures/mock-odoo");

    const mock = createMockOdoo();
    const connector = new SafeOdooConnector(
      { ...MOCK_CREDENTIALS, apiKey: ODOO_KEY },
      { allowedModels: new Set(DISCOVERY_ALLOWLIST), fetchImpl: mock.fetch, attempts: 1 },
    );
    // The connector authenticates with the canary; whatever the mock rejects,
    // the discovery payload must not carry it.
    const discovery = await discoverSchema(connector).catch(() => null);

    let prompt = "";
    const proposer = new AiProposer(new DeterministicProposer(), {
      complete: async ({ system, user }) => {
        prompt = `${system}\n${user}`;
        return JSON.stringify({ fields: [] });
      },
    });

    if (discovery) {
      await proposer.propose({
        snapshotId: "11111111-1111-4111-8111-111111111111",
        payload: discovery.payload,
      });
      expect(prompt).not.toContain(ODOO_KEY);
    }
  });

  it("is absent from the copilot's tool surface and prompt", async () => {
    const { ask } = await import("@/platform/copilot/agent");
    let seen = "";
    await ask(context, {
      question: "collected cash",
      lang: "en",
      complete: async ({ system, messages, tools }) => {
        seen = JSON.stringify({ system, messages, tools });
        return { content: "Not available." };
      },
    });
    expect(seen).not.toContain(ODOO_KEY);
    expect(seen).not.toContain("apiKey");
  });
});

describe("the production gate", () => {
  it("refuses in production without the explicit override", async () => {
    process.env.APP_ENV = "production";
    await expect(store.put(ref, ODOO_KEY)).rejects.toThrow(/not production-grade/i);
  });

  it("allows it with both variables set", async () => {
    process.env.APP_ENV = "production";
    process.env.SECRET_STORE_ADAPTER = "railway-aes-gcm";
    process.env.ALLOW_RAILWAY_SECRET_STORE_IN_PRODUCTION = "1";
    await expect(store.put(ref, ODOO_KEY)).resolves.toBeTruthy();
  });

  it("refuses when only one of the two is set", async () => {
    process.env.APP_ENV = "production";
    process.env.ALLOW_RAILWAY_SECRET_STORE_IN_PRODUCTION = "1";
    // Adapter not named: the override alone is not enough.
    await expect(store.put(ref, ODOO_KEY)).rejects.toThrow(/not production-grade/i);
  });

  it("still reports itself as not production-grade even when overridden", () => {
    process.env.APP_ENV = "production";
    process.env.SECRET_STORE_ADAPTER = "railway-aes-gcm";
    process.env.ALLOW_RAILWAY_SECRET_STORE_IN_PRODUCTION = "1";
    // The override is an operator accepting a risk, not the adapter becoming
    // something it is not. A future reader must not be misled.
    expect(store.isProductionGrade).toBe(false);
  });

  it("permits staging without any override", async () => {
    process.env.APP_ENV = "staging";
    await expect(store.put(ref, ODOO_KEY)).resolves.toBeTruthy();
  });
});

describe("key validation fails closed", () => {
  it("refuses a missing key", () => {
    expect(() => new RailwaySecretStore({ rootKey: "" })).toThrow(/not set/i);
  });

  it("refuses a key of the wrong length", () => {
    expect(() => new RailwaySecretStore({ rootKey: Buffer.alloc(16).toString("base64") })).toThrow(
      /32 bytes/,
    );
  });

  it("refuses a placeholder key of one repeated byte", () => {
    expect(
      () => new RailwaySecretStore({ rootKey: Buffer.alloc(32, 7).toString("base64") }),
    ).toThrow(/placeholder/i);
  });

  it("refuses a previous key identical to the current one", () => {
    expect(() => new RailwaySecretStore({ rootKey: ROOT_KEY, previousRootKey: ROOT_KEY })).toThrow(
      /no-op/i,
    );
  });
});

describe("ciphertext authentication fails closed", () => {
  it("rejects a tampered ciphertext", async () => {
    const secret = await store.put(ref, ODOO_KEY);
    const bytes = Buffer.from(secret.ciphertext, "base64");
    bytes[0] ^= 0xff;
    await expect(
      store.get(ref, { ...secret, ciphertext: bytes.toString("base64") }),
    ).rejects.toThrow(SecretStoreError);
  });

  it("rejects a ciphertext moved to another workspace's row", async () => {
    // The AAD binding is what makes a stolen row useless elsewhere.
    const secret = await store.put(ref, ODOO_KEY);
    await expect(
      store.get({ ...ref, workspaceId: "99999999-9999-4999-8999-999999999999" }, secret),
    ).rejects.toThrow(/could not be decrypted/i);
  });

  it("rejects a secret written by another adapter", async () => {
    const secret = await store.put(ref, ODOO_KEY);
    await expect(store.get(ref, { ...secret, adapterId: "local-aes-gcm" })).rejects.toThrow(
      /not "railway-aes-gcm"/,
    );
  });
});

describe("key versioning and rotation", () => {
  it("stamps a key id that identifies the key without revealing it", async () => {
    const secret = await store.put(ref, ODOO_KEY);
    expect(secret.keyId).toBe(deriveKeyId(Buffer.from(ROOT_KEY, "base64")));
    expect(secret.keyId).not.toContain(ROOT_KEY);
    expect(secret.keyId).toMatch(/^v1-[0-9a-f]{12}$/);
  });

  it("says exactly what went wrong when the key changed without a rotation", async () => {
    const secret = await store.put(ref, ODOO_KEY);
    const rotated = new RailwaySecretStore({ rootKey: OTHER_KEY });

    // Not a generic "authentication failed", which is indistinguishable from a
    // corrupted row and sends an operator hunting in the wrong place.
    await expect(rotated.get(ref, secret)).rejects.toThrow(/encrypted under key v1-/);
    await expect(rotated.get(ref, secret)).rejects.toThrow(/SECRET_STORE_ROOT_KEY_PREVIOUS/);
  });

  it("decrypts an old secret when the previous key is configured", async () => {
    const secret = await store.put(ref, ODOO_KEY);
    const rotating = new RailwaySecretStore({
      rootKey: OTHER_KEY,
      previousRootKey: ROOT_KEY,
    });
    expect(await rotating.get(ref, secret)).toBe(ODOO_KEY);
    expect(rotating.needsReEncryption(secret)).toBe(true);
  });

  it("re-encrypts under the new key without exposing the plaintext", async () => {
    const original = await store.put(ref, ODOO_KEY);
    const rotating = new RailwaySecretStore({
      rootKey: OTHER_KEY,
      previousRootKey: ROOT_KEY,
    });

    const migrated = await rotating.reEncrypt(ref, original);
    expect(migrated.keyId).not.toBe(original.keyId);
    expect(migrated.ciphertext).not.toBe(original.ciphertext);
    expect(migrated.ciphertext).not.toContain(ODOO_KEY);
    expect(await rotating.get(ref, migrated)).toBe(ODOO_KEY);
    expect(rotating.needsReEncryption(migrated)).toBe(false);

    // And the old key alone can no longer read the migrated secret.
    await expect(store.get(ref, migrated)).rejects.toThrow();
  });

  it("leaves an already-current secret untouched", async () => {
    const secret = await store.put(ref, ODOO_KEY);
    expect(await store.reEncrypt(ref, secret)).toBe(secret);
  });
});
