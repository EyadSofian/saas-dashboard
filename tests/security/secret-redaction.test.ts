// Secret redaction — THREAT_MODEL T2.
//
// The dangerous leak is not `{ apiKey: "..." }`, which key-based redaction
// catches trivially. It is an Odoo error string that echoed the key back, or a
// connection object serialized into a log line. Both are covered here.
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  redactSecrets,
  redactString,
  safeErrorMessage,
  withSecretRedacted,
} from "@/platform/audit/redact";
import { testOdooConnection } from "@/platform/odoo/connection-test";
import { createMockOdoo, MOCK_CREDENTIALS } from "../fixtures/mock-odoo";

const API_KEY = MOCK_CREDENTIALS.apiKey;

describe("key-based redaction", () => {
  it.each([
    "apiKey",
    "api_key",
    "API_KEY",
    "password",
    "secret",
    "token",
    "authorization",
    "credential",
    "privateKey",
    "root_key",
    "ciphertext",
    "odoo_api_key",
  ])("redacts a field named %s", (key) => {
    expect(redactSecrets({ [key]: "sensitive-value" })).toEqual({ [key]: REDACTED });
  });

  it("redacts nested fields", () => {
    const input = {
      connection: { baseUrl: "https://odoo.example.test", apiKey: "leak-me" },
      nested: [{ password: "hunter2" }],
    };
    const output = redactSecrets(input);
    expect(JSON.stringify(output)).not.toContain("leak-me");
    expect(JSON.stringify(output)).not.toContain("hunter2");
    // Non-secret fields survive — redaction must not destroy debuggability.
    expect(output.connection.baseUrl).toBe("https://odoo.example.test");
  });

  it("does not redact innocuous fields", () => {
    expect(redactSecrets({ login: "user@example.test", database: "engosoft" })).toEqual({
      login: "user@example.test",
      database: "engosoft",
    });
  });

  it("terminates on a deeply nested structure", () => {
    let deep: Record<string, unknown> = { value: "x" };
    for (let i = 0; i < 50; i++) deep = { child: deep };
    expect(() => redactSecrets(deep)).not.toThrow();
  });
});

describe("value-based redaction", () => {
  it("redacts a registered secret anywhere in a string", async () => {
    await withSecretRedacted(API_KEY, async () => {
      const message = `Odoo rejected key ${API_KEY} for database engosoft`;
      expect(redactString(message)).not.toContain(API_KEY);
      expect(redactString(message)).toContain(REDACTED);
    });
  });

  it("stops redacting once the scope ends", async () => {
    await withSecretRedacted(API_KEY, async () => {});
    // No leak here: this asserts the registry does not grow unboundedly across
    // requests, which would slow every later log line down.
    expect(redactString(`key=${API_KEY}`)).toContain(API_KEY);
  });

  it("redacts even when the secret is embedded in a nested value", async () => {
    await withSecretRedacted(API_KEY, async () => {
      const payload = { error: { detail: `auth failed for ${API_KEY}` } };
      expect(JSON.stringify(redactSecrets(payload))).not.toContain(API_KEY);
    });
  });

  it("ignores very short strings that would over-redact", async () => {
    await withSecretRedacted("abc", async () => {
      expect(redactString("abc def abc")).toBe("abc def abc");
    });
  });
});

describe("safeErrorMessage", () => {
  it("keeps only the first line and caps the length", () => {
    const error = new Error(
      "You are not allowed to access 'account.move' records.\n" +
        "This operation is allowed for: Accounting/Adviser\n" +
        "Internal path: /opt/odoo/addons/account/models/account_move.py:1423",
    );
    const message = safeErrorMessage(error);
    expect(message).toBe("You are not allowed to access 'account.move' records.");
    expect(message).not.toContain("/opt/odoo");
  });

  it("redacts a registered secret inside an error", async () => {
    await withSecretRedacted(API_KEY, async () => {
      expect(safeErrorMessage(new Error(`bad key ${API_KEY}`))).not.toContain(API_KEY);
    });
  });
});

describe("connection test never leaks the credential", () => {
  it("returns no secret in any state", async () => {
    const mock = createMockOdoo();

    for (const credentials of [
      MOCK_CREDENTIALS, // success
      { ...MOCK_CREDENTIALS, apiKey: "wrong-key-value-here" }, // auth failure
      { ...MOCK_CREDENTIALS, baseUrl: "https://169.254.169.254" }, // blocked
    ]) {
      const result = await testOdooConnection(credentials, {
        fetchImpl: mock.fetch,
        models: ["crm.lead", "account.move"],
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(credentials.apiKey);
      expect(serialized).not.toContain(MOCK_CREDENTIALS.apiKey);
    }
  });

  it("reports a permission gap without echoing Odoo internals", async () => {
    const mock = createMockOdoo();
    const result = await testOdooConnection(MOCK_CREDENTIALS, {
      fetchImpl: mock.fetch,
      models: ["crm.lead", "account.partial.reconcile"],
    });
    const denied = result.probes.find((p) => p.model === "account.partial.reconcile");
    expect(denied?.canRead).toBe(false);
    expect(denied?.gap?.reason).toBe("access_denied");
    // First line only — the group list and file paths are dropped.
    expect(denied?.gap?.detail).not.toContain("\n");
    expect(denied?.gap?.detail.length).toBeLessThanOrEqual(300);
  });
});
