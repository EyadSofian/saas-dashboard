// Connection-test states and last-good preservation.
//
// Milestone acceptance C (every connection state is covered) and F (a failed
// discovery preserves the previous snapshot).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { connectionTestFailure, testOdooConnection } from "@/platform/odoo/connection-test";
import {
  CONNECTION_TEST_STATES,
  connectionTestResultSchema,
  odooConnectionInputSchema,
  type WorkspaceContext,
} from "@/platform/contracts";
import { discoverSchema } from "@/platform/discovery/discover";
import { SafeOdooConnector } from "@/platform/odoo/connector";
import { DISCOVERY_ALLOWLIST } from "@/platform/odoo/allowlist";
import { getSecretStore, LocalAesGcmSecretStore, SecretStoreError } from "@/platform/secrets";
import { closePool } from "@/platform/db/pool";
import {
  getConnection,
  loadConnectionSecret,
  recordConnectionTest,
  upsertConnection,
} from "@/platform/workspace/repository";
import { createMockOdoo, DEFAULT_MODELS, MOCK_CREDENTIALS } from "../fixtures/mock-odoo";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";

const SMALL_SET = ["crm.lead", "sale.order"] as const;

describe("acceptance C · every connection state", () => {
  it("success", async () => {
    const mock = createMockOdoo();
    const result = await testOdooConnection(MOCK_CREDENTIALS, {
      fetchImpl: mock.fetch,
      models: SMALL_SET,
    });
    expect(result.state).toBe("success");
    expect(result.ok).toBe(true);
    expect(result.serverVersion).toBe("17.0+e");
    expect(result.uid).toBe(7);
  });

  it("bad API key", async () => {
    const mock = createMockOdoo();
    const result = await testOdooConnection(
      { ...MOCK_CREDENTIALS, apiKey: "wrong-key-entirely" },
      { fetchImpl: mock.fetch, models: SMALL_SET },
    );
    expect(result.state).toBe("auth_failed");
    expect(result.message.ar).toContain("رفض أودو");
  });

  it("wrong database name", async () => {
    const mock = createMockOdoo();
    const result = await testOdooConnection(
      { ...MOCK_CREDENTIALS, database: "not_the_right_db" },
      { fetchImpl: mock.fetch, models: SMALL_SET },
    );
    expect(result.state).toBe("auth_failed");
  });

  it("ACL denied on every model", async () => {
    // Credentials work, but the integration user can read nothing useful — a
    // distinct, actionable state, not a generic failure.
    const models = structuredClone(DEFAULT_MODELS);
    for (const key of Object.keys(models)) models[key].denyRead = true;
    const mock = createMockOdoo({ models });

    const result = await testOdooConnection(MOCK_CREDENTIALS, {
      fetchImpl: mock.fetch,
      models: SMALL_SET,
    });
    expect(result.state).toBe("access_denied");
    expect(result.ok).toBe(false);
    expect(result.probes.every((p) => !p.canRead)).toBe(true);
    expect(result.probes.every((p) => p.gap?.reason === "access_denied")).toBe(true);
  });

  it("partial ACL denial still succeeds and reports the gap", async () => {
    const mock = createMockOdoo();
    const result = await testOdooConnection(MOCK_CREDENTIALS, {
      fetchImpl: mock.fetch,
      models: ["crm.lead", "account.partial.reconcile"],
    });
    expect(result.state).toBe("success");
    expect(result.probes.find((p) => p.model === "crm.lead")?.canRead).toBe(true);
    expect(result.probes.find((p) => p.model === "account.partial.reconcile")?.gap?.reason).toBe(
      "access_denied",
    );
  });

  it("timeout", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that never settles until the abort signal fires.
      const hangingFetch: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted due to timeout");
            error.name = "TimeoutError";
            reject(error);
          });
        });

      const pending = testOdooConnection(MOCK_CREDENTIALS, {
        fetchImpl: hangingFetch,
        models: SMALL_SET,
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;
      expect(result.state).toBe("timeout");
      expect(result.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalid URL", async () => {
    const mock = createMockOdoo();
    const result = await testOdooConnection(
      { ...MOCK_CREDENTIALS, baseUrl: "not even a url" },
      { fetchImpl: mock.fetch, models: SMALL_SET },
    );
    expect(result.state).toBe("blocked_target");
  });

  it("SSRF target", async () => {
    const mock = createMockOdoo();
    for (const baseUrl of [
      "https://169.254.169.254/",
      "https://127.0.0.1:8069/",
      "http://odoo.internal.example.com/",
    ]) {
      const result = await testOdooConnection(
        { ...MOCK_CREDENTIALS, baseUrl },
        { fetchImpl: mock.fetch, models: SMALL_SET },
      );
      expect(result.ok, `${baseUrl} was not blocked`).toBe(false);
      expect(result.state).toBe("blocked_target");
    }
    // No request was ever made to a blocked target.
    expect(mock.calls).toHaveLength(0);
  });

  it("unreachable server", async () => {
    const failingFetch: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    const result = await testOdooConnection(MOCK_CREDENTIALS, {
      fetchImpl: failingFetch,
      models: SMALL_SET,
    });
    expect(result.state).toBe("unreachable");
  });

  it("missing credentials", async () => {
    const mock = createMockOdoo();
    const result = await testOdooConnection(
      { ...MOCK_CREDENTIALS, apiKey: "" },
      { fetchImpl: mock.fetch, models: SMALL_SET },
    );
    expect(result.state).toBe("not_configured");
  });
});

describe("acceptance C · credential rotation and corruption", () => {
  const store = new LocalAesGcmSecretStore("Zq4vN8xKp2mR7tYw3sJhBc5dFgLnQaEuIoPzXvCbTyU=");
  const ref = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    connectionId: "22222222-2222-4222-8222-222222222222",
    purpose: "odoo_api_key",
  };

  it("a rotated credential is the one the connector uses", async () => {
    const rotated = await store.rotate(ref, MOCK_CREDENTIALS.apiKey);
    const apiKey = await store.get(ref, rotated);
    const mock = createMockOdoo();
    const result = await testOdooConnection(
      { ...MOCK_CREDENTIALS, apiKey },
      { fetchImpl: mock.fetch, models: SMALL_SET },
    );
    expect(result.state).toBe("success");
  });

  it("corrupted ciphertext fails closed rather than falling back", async () => {
    const stored = await store.put(ref, MOCK_CREDENTIALS.apiKey);
    const corrupted = Buffer.from(stored.ciphertext, "base64");
    corrupted[2] ^= 0xff;
    await expect(
      store.get(ref, { ...stored, ciphertext: corrupted.toString("base64") }),
    ).rejects.toThrow(SecretStoreError);
  });

  // The test-connection route branches on this exact `kind` to turn an
  // unreadable credential into a rendered state instead of a 500. If the kind
  // ever drifts, that branch silently stops matching.
  it.each([
    [
      "a rotated root key",
      async () => {
        const stored = await store.put(ref, MOCK_CREDENTIALS.apiKey);
        const other = new LocalAesGcmSecretStore("T3nGpQ8bZ1wLxK5vRj7cYm2dHsA9uEfNoIiPzXvCbTy=");
        return other.get(ref, stored);
      },
    ],
    [
      "a ciphertext copied from another workspace",
      async () => {
        const stored = await store.put(ref, MOCK_CREDENTIALS.apiKey);
        return store.get({ ...ref, workspaceId: "33333333-3333-4333-8333-333333333333" }, stored);
      },
    ],
  ])("%s reports decrypt_failed, the kind the route recovers from", async (_name, attempt) => {
    await expect(attempt()).rejects.toMatchObject({ kind: "decrypt_failed" });
  });
});

describe("acceptance C · every state is renderable", () => {
  // The wizard renders `state` and `message` for every outcome, so a state
  // without a message would be a blank banner rather than a caught error.
  it.each(CONNECTION_TEST_STATES)("%s carries a message in both languages", (state) => {
    const result = connectionTestFailure(state);
    expect(connectionTestResultSchema.safeParse(result).success).toBe(true);
    expect(result.message.ar.length).toBeGreaterThan(0);
    expect(result.message.en.length).toBeGreaterThan(0);
  });

  it("credential_unreadable tells the customer how to recover", () => {
    const result = connectionTestFailure("credential_unreadable");
    expect(result.ok).toBe(false);
    expect(result.probes).toEqual([]);
    // Odoo is never contacted, so there is nothing to report about the server.
    expect(result.serverVersion).toBeNull();
    expect(result.uid).toBeNull();
    // Actionable, not diagnostic: re-entering the key is the whole recovery.
    expect(result.message.en).toMatch(/enter the API key again/i);
    expect(result.message.ar).toContain("أدخل المفتاح مرة أخرى");
  });
});

describe("the API key is optional once one is stored", () => {
  const details = {
    baseUrl: "https://company.odoo.test",
    database: "company_db",
    login: "analytics@company.test",
  };

  it("accepts a save that omits the key entirely", () => {
    expect(odooConnectionInputSchema.parse(details).apiKey).toBeUndefined();
  });

  it("reads the empty field the wizard always sends as 'keep the stored key'", () => {
    // The wizard posts the whole form, so the field is present and empty rather
    // than absent. Rejecting that as too short is what produced the confusing
    // 400 on a URL-only correction.
    expect(odooConnectionInputSchema.parse({ ...details, apiKey: "" }).apiKey).toBeUndefined();
  });

  it("carries a supplied key through unchanged", () => {
    expect(odooConnectionInputSchema.parse({ ...details, apiKey: "  spaced  " }).apiKey).toBe(
      "  spaced  ",
    );
  });

  it("still refuses an oversized key", () => {
    const parsed = odooConnectionInputSchema.safeParse({
      ...details,
      apiKey: "x".repeat(513),
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The verdict rules live in SQL, so they are exercised against a real
 * PostgreSQL through the repository the route calls — as the RLS-bound runtime
 * role, not as a superuser.
 */
describe("acceptance C · a save that reuses the stored credential", () => {
  const ORG = "00000000-0000-4000-8000-00000000000c";
  const WS = "00000000-0000-4000-8000-00000000001c";
  const USER = "00000000-0000-4000-8000-0000000000c1";
  const BARE_ORG = "00000000-0000-4000-8000-00000000000d";
  const BARE_WS = "00000000-0000-4000-8000-00000000001d";
  const BARE_USER = "00000000-0000-4000-8000-0000000000d1";

  const context: WorkspaceContext = {
    workspaceId: WS,
    organizationId: ORG,
    userId: USER,
    roles: ["workspace_owner"],
  };
  const bareContext: WorkspaceContext = {
    workspaceId: BARE_WS,
    organizationId: BARE_ORG,
    userId: BARE_USER,
    roles: ["workspace_owner"],
  };

  const DETAILS = {
    baseUrl: "https://company.odoo.test",
    database: "company_db",
    login: "analytics@company.test",
  };

  let database: TestDatabase;
  let adminPool: Pool;

  /**
   * The POST handler's own sequence: resolve the connection id first (the AAD
   * binding needs one before the row exists), then either encrypt a new key or
   * carry the stored ciphertext across untouched.
   */
  async function save(
    ctx: WorkspaceContext,
    { apiKey, ...details }: Partial<typeof DETAILS> & { apiKey?: string },
  ) {
    const existing = await getConnection(ctx);
    const connectionId = existing?.id ?? crypto.randomUUID();
    const secret =
      apiKey === undefined
        ? existing && (await loadConnectionSecret(ctx, existing.id))
        : await getSecretStore().put(
            { workspaceId: ctx.workspaceId, connectionId, purpose: "odoo_api_key" },
            apiKey,
          );
    // What the route answers with a 400 rather than storing a connection whose
    // credential does not exist.
    if (!secret) throw new Error("no stored credential to reuse");
    return upsertConnection(ctx, {
      ...DETAILS,
      ...details,
      connectionId,
      secret,
      credentialReplaced: apiKey !== undefined,
    });
  }

  async function secretRow(connectionId: string) {
    const { rows } = await adminPool.query<{ ciphertext: string; rotated_at: Date | null }>(
      "SELECT ciphertext, rotated_at FROM connection_secret_refs WHERE connection_id = $1",
      [connectionId],
    );
    return rows[0];
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    adminPool = new Pool({ connectionString: database.url, max: 4 });
    for (const migration of ["0001_workspace_foundation", "0002_legacy_workspace_backfill"]) {
      const file = path.resolve(process.cwd(), "migrations", `${migration}.up.sql`);
      await adminPool.query(await readFile(file, "utf8"));
    }
    await adminPool.query("ALTER ROLE insights_app WITH LOGIN PASSWORD 'app-password'");

    for (const [org, ws, user, name] of [
      [ORG, WS, USER, "company"],
      [BARE_ORG, BARE_WS, BARE_USER, "bare"],
    ] as const) {
      await adminPool.query("INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)", [
        org,
        name,
        name,
      ]);
      await adminPool.query(
        "INSERT INTO workspaces (id, organization_id, name, slug) VALUES ($1,$2,$3,$3)",
        [ws, org, name],
      );
      await adminPool.query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
        user,
        `owner@${name}.test`,
        name,
      ]);
      await adminPool.query(
        `INSERT INTO memberships (user_id, organization_id, workspace_id, roles)
         VALUES ($1,$2,$3,ARRAY['workspace_owner'])`,
        [user, org, ws],
      );
    }

    // A connection whose credential never arrived: the state the route must
    // refuse to save on top of.
    await adminPool.query(
      `INSERT INTO odoo_connections (workspace_id, base_url, database, login, status)
       VALUES ($1,'https://bare.odoo.test','bare_db','bare@example.test','draft')`,
      [BARE_WS],
    );

    // The repository connects through DATABASE_URL, as the runtime role.
    process.env.DATABASE_URL = database.url.replace(
      "postgres:postgres@",
      "insights_app:app-password@",
    );
  }, 120_000);

  afterAll(async () => {
    await closePool().catch(() => undefined);
    await adminPool?.end().catch(() => undefined);
    await database?.stop().catch(() => undefined);
  });

  beforeEach(async () => {
    // Each case starts from a workspace with no connection at all.
    await adminPool.query("DELETE FROM odoo_connections WHERE workspace_id = $1", [WS]);
  });

  it("binds a new credential to the row it creates, not to a discarded id", async () => {
    const connection = await save(context, { apiKey: "first-key" });
    const stored = await loadConnectionSecret(context, connection.id);
    expect(stored).not.toBeNull();

    // The AAD binds the ciphertext to workspace + connection + purpose, so this
    // only succeeds if the id the key was encrypted under is the id the row
    // actually received. A mismatch is indistinguishable from a rotated root
    // key: every test of a brand-new connection would report
    // `credential_unreadable`.
    await expect(
      getSecretStore().get(
        { workspaceId: WS, connectionId: connection.id, purpose: "odoo_api_key" },
        stored!,
      ),
    ).resolves.toBe("first-key");
  });

  it("keeps the ciphertext and its rotation time byte-for-byte", async () => {
    const created = await save(context, { apiKey: "first-key" });
    const before = await secretRow(created.id);

    const updated = await save(context, { login: "reporting@company.test" });
    const after = await secretRow(created.id);

    expect(updated.id).toBe(created.id);
    expect(updated.login).toBe("reporting@company.test");
    expect(after.ciphertext).toBe(before.ciphertext);
    // `rotated_at` means "when the key last changed", not "when the form was
    // last submitted".
    expect(after.rotated_at?.toISOString()).toBe(before.rotated_at?.toISOString());
    expect(updated.hasSecret).toBe(true);
  });

  it("drops a verdict that described the details it just changed", async () => {
    const created = await save(context, { apiKey: "first-key" });
    await recordConnectionTest(context, created.id, "auth_failed", "17.0");

    const updated = await save(context, { baseUrl: "https://moved.odoo.test" });

    // The old verdict was about a different host, so reporting it would be a
    // claim about a connection that no longer exists.
    expect(updated.baseUrl).toBe("https://moved.odoo.test");
    expect(updated.lastTestState).toBeNull();
    expect(updated.lastTestedAt).toBeNull();
    expect(updated.status).toBe("draft");
    // The verdict went; the Odoo version discovered under it is not a verdict.
    expect(updated.odooVersion).toBe("17.0");
  });

  it("cannot be used to clear credential_unreadable without replacing the key", async () => {
    const created = await save(context, { apiKey: "first-key" });
    await recordConnectionTest(context, created.id, "credential_unreadable", null);
    const broken = await getConnection(context);

    const updated = await save(context, { database: "company_db_2" });

    // The edit still landed…
    expect(updated.database).toBe("company_db_2");
    // …but the ciphertext this save carried over is the unreadable one, so the
    // connection is still exactly as broken as it was.
    expect(updated.lastTestState).toBe("credential_unreadable");
    expect(updated.status).toBe("failed");
    expect(updated.lastTestedAt).toBe(broken?.lastTestedAt);
  });

  it("clears credential_unreadable once the key is actually replaced", async () => {
    const created = await save(context, { apiKey: "first-key" });
    const before = await secretRow(created.id);
    await recordConnectionTest(context, created.id, "credential_unreadable", null);

    const updated = await save(context, { apiKey: "replacement-key" });
    const after = await secretRow(created.id);

    expect(updated.lastTestState).toBeNull();
    expect(updated.lastTestedAt).toBeNull();
    expect(updated.status).toBe("draft");
    expect(after.ciphertext).not.toBe(before.ciphertext);
    expect(after.rotated_at).not.toBeNull();
    await expect(
      getSecretStore().get(
        { workspaceId: WS, connectionId: created.id, purpose: "odoo_api_key" },
        (await loadConnectionSecret(context, created.id))!,
      ),
    ).resolves.toBe("replacement-key");
  });

  it("has nothing to reuse when the connection never had a credential", async () => {
    const bare = await getConnection(bareContext);
    expect(bare?.hasSecret).toBe(false);
    // The route turns this null into a 400 rather than writing a connection
    // whose credential does not exist.
    await expect(loadConnectionSecret(bareContext, bare!.id)).resolves.toBeNull();
    await expect(save(bareContext, { login: "someone@bare.test" })).rejects.toThrow(
      "no stored credential to reuse",
    );
  });
});

describe("acceptance F · last-good preservation", () => {
  function connector(mockOptions = {}) {
    const mock = createMockOdoo(mockOptions);
    return new SafeOdooConnector(MOCK_CREDENTIALS, {
      allowedModels: new Set([
        ...DISCOVERY_ALLOWLIST,
        "res.partner",
        "crm.lost.reason",
        "res.country",
      ]),
      fetchImpl: mock.fetch,
      attempts: 1,
      timeoutMs: 5_000,
    });
  }

  it("a discovery failure produces no snapshot to overwrite the previous one", async () => {
    // A healthy run first: this is the "last good" result.
    const good = await discoverSchema(connector());
    expect(good.payload.models.length).toBeGreaterThan(10);

    // Now every model fails. Discovery still completes, but produces a payload
    // with no accessible models — and, crucially, it never mutates or deletes
    // anything belonging to the previous run.
    const models = structuredClone(DEFAULT_MODELS);
    for (const key of Object.keys(models)) models[key].denyRead = true;
    const failed = await discoverSchema(connector({ models }));

    expect(failed.permissionGaps.length).toBeGreaterThan(0);
    expect(failed.payload.models.every((m) => !m.accessible)).toBe(true);
    expect(failed.hash).not.toBe(good.hash);

    // The healthy result is still intact and re-derivable — a failed scan
    // cannot have corrupted it, because discovery returns a new value rather
    // than mutating shared state.
    const again = await discoverSchema(connector());
    expect(again.hash).toBe(good.hash);
  });

  it("a mid-scan transport failure does not discard already-discovered models", async () => {
    let checkpoint: Record<string, unknown> = {};
    const controller = new AbortController();

    await discoverSchema(connector(), {
      ctx: {
        signal: controller.signal,
        resumeFrom: {},
        checkpoint: async (state) => {
          checkpoint = state;
          if ((state.completedModels as string[]).length >= 3) controller.abort();
        },
      },
    });

    // What was discovered before the failure survives in the checkpoint.
    expect((checkpoint.completedModels as string[]).length).toBeGreaterThanOrEqual(3);
    expect((checkpoint.fields as unknown[]).length).toBeGreaterThan(0);
  });

  it("a model that times out becomes a gap, not a lost scan", async () => {
    const models = structuredClone(DEFAULT_MODELS);
    // A model whose fields_get errors: the scan records it and moves on.
    models["sale.order"].denyRead = true;
    const result = await discoverSchema(connector({ models }));

    expect(result.permissionGaps.some((g) => g.model === "sale.order")).toBe(true);
    // Everything else still made it.
    expect(result.payload.models.find((m) => m.model === "crm.lead")?.accessible).toBe(true);
    expect(result.payload.fields.some((f) => f.model === "account.move")).toBe(true);
  });
});
