// Connector least privilege — THREAT_MODEL T7.
//
// The key property is that a forbidden call is refused BEFORE any network I/O,
// which is what makes the allowlist a control rather than a filter. Every test
// here asserts both the rejection and that `calls` stayed empty.
import { describe, expect, it } from "vitest";
import { SafeOdooConnector } from "@/platform/odoo/connector";
import {
  ALLOWED_METHODS,
  DISCOVERY_ALLOWLIST,
  ForbiddenOdooCallError,
  FORBIDDEN_METHODS,
  assertCallAllowed,
} from "@/platform/odoo/allowlist";
import { createMockOdoo, MOCK_CREDENTIALS } from "../fixtures/mock-odoo";

function connectorWith(models: string[] = [...DISCOVERY_ALLOWLIST]) {
  const mock = createMockOdoo();
  const connector = new SafeOdooConnector(MOCK_CREDENTIALS, {
    allowedModels: new Set(models),
    fetchImpl: mock.fetch,
    attempts: 1,
  });
  return { mock, connector };
}

describe("method allowlist", () => {
  it.each([...FORBIDDEN_METHODS])("refuses %s without making a request", async (method) => {
    const { mock, connector } = connectorWith();
    await expect(connector.call("crm.lead", method)).rejects.toThrow(ForbiddenOdooCallError);
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses an arbitrary custom method", async () => {
    const { mock, connector } = connectorWith();
    await expect(connector.call("crm.lead", "action_do_something_dangerous")).rejects.toThrow(
      /not permitted/i,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("permits exactly the read methods and nothing else", () => {
    expect([...ALLOWED_METHODS].sort()).toEqual(
      ["fields_get", "read", "read_group", "search_count", "search_read"].sort(),
    );
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(ALLOWED_METHODS.has(forbidden)).toBe(false);
    }
  });
});

describe("model allowlist", () => {
  it("refuses a model outside the workspace's approved scope", async () => {
    const { mock, connector } = connectorWith(["crm.lead"]);
    await expect(connector.call("res.users", "fields_get")).rejects.toThrow(
      /outside the approved/i,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses a model that is not a valid Odoo model name", async () => {
    const { mock, connector } = connectorWith();
    for (const bad of ["crm.lead; DROP TABLE", "../../etc/passwd", "CRM.Lead", ""]) {
      await expect(connector.call(bad, "fields_get")).rejects.toThrow(ForbiddenOdooCallError);
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("permits an allowlisted model", async () => {
    const { mock, connector } = connectorWith();
    await expect(connector.fieldsGet("crm.lead")).resolves.toBeTypeOf("object");
    expect(mock.calls.some((c) => c.modelMethod === "fields_get")).toBe(true);
  });
});

describe("assertCallAllowed", () => {
  it("fails closed on an empty allowed-model set", () => {
    expect(() => assertCallAllowed("crm.lead", "read", new Set())).toThrow(ForbiddenOdooCallError);
  });
});

describe("transport hardening", () => {
  it("refuses to follow a redirect", async () => {
    // A redirect could deliver the request body — which contains the API key —
    // to an address that never passed the SSRF check.
    const mock = createMockOdoo({ redirect: true });
    const connector = new SafeOdooConnector(MOCK_CREDENTIALS, {
      allowedModels: new Set(DISCOVERY_ALLOWLIST),
      fetchImpl: mock.fetch,
      attempts: 1,
    });
    await expect(connector.version()).rejects.toThrow(/redirected/i);
  });

  it("rejects bad credentials as an auth failure", async () => {
    const mock = createMockOdoo();
    const connector = new SafeOdooConnector(
      { ...MOCK_CREDENTIALS, apiKey: "wrong-key" },
      { allowedModels: new Set(DISCOVERY_ALLOWLIST), fetchImpl: mock.fetch, attempts: 1 },
    );
    await expect(connector.authenticate()).rejects.toThrow(/rejected these credentials/i);
  });

  it("does not retry an access error", async () => {
    const mock = createMockOdoo();
    const connector = new SafeOdooConnector(MOCK_CREDENTIALS, {
      allowedModels: new Set(DISCOVERY_ALLOWLIST),
      fetchImpl: mock.fetch,
      attempts: 3,
    });
    await expect(connector.fieldsGet("account.partial.reconcile")).rejects.toThrow();
    const fieldsGetCalls = mock.calls.filter(
      (c) => c.model === "account.partial.reconcile" && c.modelMethod === "fields_get",
    );
    expect(fieldsGetCalls).toHaveLength(1);
  });
});
