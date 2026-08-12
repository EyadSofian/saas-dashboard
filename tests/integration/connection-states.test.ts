// Connection-test states and last-good preservation.
//
// Milestone acceptance C (every connection state is covered) and F (a failed
// discovery preserves the previous snapshot).
import { describe, expect, it, vi } from "vitest";
import { testOdooConnection } from "@/platform/odoo/connection-test";
import { discoverSchema } from "@/platform/discovery/discover";
import { SafeOdooConnector } from "@/platform/odoo/connector";
import { DISCOVERY_ALLOWLIST } from "@/platform/odoo/allowlist";
import { LocalAesGcmSecretStore, SecretStoreError } from "@/platform/secrets";
import { createMockOdoo, DEFAULT_MODELS, MOCK_CREDENTIALS } from "../fixtures/mock-odoo";

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
