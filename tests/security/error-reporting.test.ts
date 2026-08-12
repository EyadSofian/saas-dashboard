// Error reporting must never carry a credential to a third party.
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryReporter,
  NoopReporter,
  SentryReporter,
  buildPayload,
  getErrorReporter,
  reportError,
  setErrorReporter,
} from "@/platform/observability/errors";
import { withSecretRedacted } from "@/platform/audit/redact";

const CANARY = "ZZ-ODOO-KEY-CANARY-4b81ff-DO-NOT-SEND";

afterEach(() => {
  setErrorReporter(null);
  delete process.env.SENTRY_DSN;
});

describe("payloads carry no credential", () => {
  it("drops any field named like a secret", () => {
    const payload = buildPayload(new Error("boom"), {
      extra: { apiKey: CANARY, password: CANARY, note: "safe" },
    });
    expect(JSON.stringify(payload)).not.toContain(CANARY);
    expect(JSON.stringify(payload)).toContain("safe");
  });

  it("drops a live credential hidden in an innocently-named field", async () => {
    // The realistic case: a value copied into `detail` while handling a request.
    await withSecretRedacted(CANARY, async () => {
      const payload = buildPayload(new Error("boom"), { extra: { detail: `key=${CANARY}` } });
      expect(JSON.stringify(payload)).not.toContain(CANARY);
    });
  });

  it("drops a credential concatenated into the message", async () => {
    await withSecretRedacted(CANARY, async () => {
      const payload = buildPayload(new Error(`Odoo rejected ${CANARY}`));
      expect(JSON.stringify(payload)).not.toContain(CANARY);
    });
  });

  it("keeps what makes an error diagnosable", () => {
    const payload = buildPayload(new Error("connection refused"), {
      workspaceId: "ws-1",
      operation: "sync",
    }) as Record<string, unknown>;
    expect(payload.message).toContain("connection refused");
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.operation).toBe("sync");
    expect(String(payload.stack)).toContain("Error");
  });

  it("bounds the stack rather than sending an unbounded one", () => {
    const payload = buildPayload(new Error("deep")) as Record<string, unknown>;
    expect(String(payload.stack).split("\n").length).toBeLessThanOrEqual(20);
  });
});

describe("nothing leaves the process when it should not", () => {
  it("defaults to a no-op with no DSN", () => {
    expect(getErrorReporter().id).toBe("noop");
  });

  it("falls back to no-op on a malformed DSN rather than crashing at boot", () => {
    process.env.SENTRY_DSN = "not-a-dsn";
    expect(getErrorReporter().id).toBe("noop");
  });

  it("never lets a reporting failure become the failure", async () => {
    // An outage at the tracker must not turn a handled 500 into an unhandled one.
    setErrorReporter({
      id: "broken",
      report: async () => {
        throw new Error("sentry is down");
      },
    });
    expect(() => reportError(new Error("original"))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("sends nothing at all through the no-op", async () => {
    const noop = new NoopReporter();
    await expect(noop.report(new Error("x"))).resolves.toBeUndefined();
  });
});

describe("the wire payload", () => {
  it("carries no credential and no ingestion key in the body", async () => {
    let body = "";
    const capturing: typeof fetch = async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    };
    const reporter = new SentryReporter("https://publickey123@ingest.example.test/456", capturing);

    await withSecretRedacted(CANARY, async () => {
      await reporter.report(new Error(`failed with ${CANARY}`), {
        workspaceId: "ws-1",
        extra: { apiKey: CANARY },
      });
    });

    expect(body).not.toContain(CANARY);
    // The ingestion key belongs in the auth header, not in the payload.
    expect(body).not.toContain("publickey123");
    expect(body).toContain("ws-1");
  });

  it("tags the workspace so one customer's incident is separable", async () => {
    const memory = new MemoryReporter();
    setErrorReporter(memory);
    await memory.report(new Error("x"), { workspaceId: "ws-9", operation: "discovery" });
    expect(memory.reports[0].workspaceId).toBe("ws-9");
  });
});
