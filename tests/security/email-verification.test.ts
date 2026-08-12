// Email verification and the mail transport.
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsoleTransport,
  ResendTransport,
  emailVerificationRequired,
  getMailTransport,
  invitationMessage,
  setMailTransport,
  trySend,
  verificationMessage,
} from "@/platform/auth/mailer";

afterEach(() => {
  setMailTransport(null);
  delete process.env.APP_ENV;
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
  delete process.env.REQUIRE_EMAIL_VERIFICATION;
});

describe("verification is on unless explicitly disabled", () => {
  it("defaults to required", () => {
    expect(emailVerificationRequired()).toBe(true);
  });

  it("can be turned off deliberately", () => {
    for (const value of ["0", "false", "off"]) {
      process.env.REQUIRE_EMAIL_VERIFICATION = value;
      expect(emailVerificationRequired()).toBe(false);
    }
  });

  it("stays on for any other value, including a typo", () => {
    // "no" is not in the disable list, and a typo must not silently open
    // sign-up to unverified addresses.
    process.env.REQUIRE_EMAIL_VERIFICATION = "no";
    expect(emailVerificationRequired()).toBe(true);
  });
});

describe("transport selection", () => {
  it("uses the console in development", () => {
    expect(getMailTransport().id).toBe("console");
  });

  it("uses the provider when configured", () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.MAIL_FROM = "InsightOS <hello@example.test>";
    const chosen = getMailTransport();
    expect(chosen.id).toBe("resend");
    expect(chosen.deliversForReal).toBe(true);
  });

  it("refuses to start in production with no transport", () => {
    // A production deployment must never print a verification link into its
    // logs, and must not create accounts nobody can confirm.
    process.env.APP_ENV = "production";
    expect(() => getMailTransport()).toThrow(/No email transport is configured/);
  });

  it("names the two ways out in that error", () => {
    process.env.APP_ENV = "production";
    expect(() => getMailTransport()).toThrow(/RESEND_API_KEY/);
    expect(() => getMailTransport()).toThrow(/REQUIRE_EMAIL_VERIFICATION=0/);
  });
});

describe("messages", () => {
  it("carries the link and states the expiry", () => {
    const message = verificationMessage("a@b.test", "https://app.test/verify?token=abc");
    expect(message.text).toContain("https://app.test/verify?token=abc");
    expect(message.text).toContain("ساعة");
    // Tells a recipient who did not ask that ignoring it is safe.
    expect(message.text).toContain("تجاهل");
  });

  it("is available in English too", () => {
    const message = verificationMessage("a@b.test", "https://app.test/v", "en");
    expect(message.subject).toContain("Confirm");
    expect(message.text).toContain("ignore this message");
  });

  it("tells an invitee which address must accept", () => {
    const message = invitationMessage("a@b.test", "Alpha", "https://app.test/i", "en");
    expect(message.text).toContain("Alpha");
    expect(message.text).toContain("must be accepted with this address");
  });

  it("is plain text, so no client can be tracked by a pixel", () => {
    const message = verificationMessage("a@b.test", "https://app.test/v");
    expect(Object.keys(message)).toEqual(["to", "subject", "text"]);
  });
});

describe("delivery", () => {
  it("reports success", async () => {
    const transport = new ConsoleTransport();
    setMailTransport(transport);
    expect(await trySend(verificationMessage("a@b.test", "https://app.test/v"))).toEqual({
      sent: true,
    });
    expect(transport.sent).toHaveLength(1);
  });

  it("reports a failure instead of throwing", async () => {
    // A delivery failure must not leave a half-created account with no way
    // forward; the caller decides what to tell the user.
    setMailTransport({
      id: "broken",
      deliversForReal: true,
      send: async () => {
        throw new Error("provider is down");
      },
    });
    const result = await trySend(verificationMessage("a@b.test", "https://app.test/v"));
    expect(result.sent).toBe(false);
    expect(result.error).toContain("provider is down");
  });

  it("never echoes the provider's response body", async () => {
    // A provider error body can contain the recipient and an API key prefix.
    const failing: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "invalid api key re_secret_abc123" }), {
        status: 401,
      });
    const transport = new ResendTransport("re_secret_abc123", "a@b.test", failing);
    setMailTransport(transport);

    const result = await trySend(verificationMessage("a@b.test", "https://app.test/v"));
    expect(result.sent).toBe(false);
    expect(result.error).not.toContain("re_secret_abc123");
    expect(result.error).toContain("401");
  });

  it("sends the API key as a header, never in the body", async () => {
    let captured = "";
    const capturing: typeof fetch = async (_url, init) => {
      captured = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    };
    const transport = new ResendTransport("re_secret_abc123", "a@b.test", capturing);
    setMailTransport(transport);

    await trySend(verificationMessage("a@b.test", "https://app.test/v"));
    expect(captured).not.toContain("re_secret_abc123");
  });
});
