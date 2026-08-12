// SSRF guard — THREAT_MODEL T3.
import { describe, expect, it } from "vitest";
import { addressIsPrivate, assertSafeOdooUrl, UnsafeUrlError } from "@/platform/odoo/url-guard";

async function reject(url: string): Promise<UnsafeUrlError> {
  try {
    await assertSafeOdooUrl(url);
  } catch (error) {
    if (error instanceof UnsafeUrlError) return error;
    throw error;
  }
  throw new Error(`Expected ${url} to be rejected, but it was allowed.`);
}

describe("addressIsPrivate", () => {
  it.each([
    ["169.254.169.254", "cloud metadata"],
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private class A"],
    ["172.16.0.1", "private class B lower bound"],
    ["172.31.255.254", "private class B upper bound"],
    ["192.168.1.1", "private class C"],
    ["100.64.0.1", "CGNAT"],
    ["0.0.0.0", "this network"],
    ["224.0.0.1", "multicast"],
    ["::1", "IPv6 loopback"],
    ["fd00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link-local"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["not-an-ip", "unparseable"],
  ])("treats %s (%s) as private", (ip) => {
    expect(addressIsPrivate(ip)).toBe(true);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["172.32.0.1"], ["2606:4700::1111"]])(
    "treats %s as public",
    (ip) => {
      expect(addressIsPrivate(ip)).toBe(false);
    },
  );
});

describe("assertSafeOdooUrl", () => {
  it("rejects a literal cloud-metadata address", async () => {
    expect((await reject("https://169.254.169.254/")).reason).toBe("private_address");
  });

  it("rejects loopback and private literals", async () => {
    expect((await reject("https://127.0.0.1:8069/")).reason).toBe("private_address");
    expect((await reject("https://10.0.0.5/")).reason).toBe("private_address");
    expect((await reject("https://[::1]/")).reason).toBe("private_address");
  });

  it("rejects non-https schemes", async () => {
    expect((await reject("http://odoo.example.com/")).reason).toBe("scheme");
    expect((await reject("file:///etc/passwd")).reason).toBe("scheme");
    expect((await reject("gopher://odoo.example.com/")).reason).toBe("scheme");
    expect((await reject("ftp://odoo.example.com/")).reason).toBe("scheme");
  });

  it("rejects credentials embedded in the URL", async () => {
    expect((await reject("https://user:pass@odoo.example.test/")).reason).toBe("credentials");
  });

  it("rejects non-standard ports", async () => {
    // 22 and 6379 are the classic internal-service pivots.
    expect((await reject("https://odoo.example.test:22/")).reason).toBe("port");
    expect((await reject("https://odoo.example.test:6379/")).reason).toBe("port");
    expect((await reject("https://odoo.example.test:5432/")).reason).toBe("port");
  });

  it("rejects a hostname that cannot be resolved", async () => {
    const error = await reject("https://this-host-does-not-exist.invalid/");
    expect(error.reason).toBe("resolve_failed");
  });

  it("rejects garbage input", async () => {
    expect((await reject("not a url at all")).reason).toBe("hostname");
  });

  it("rejects localhost unless explicitly allowlisted", async () => {
    const previous = process.env.ODOO_DEV_HOST_ALLOWLIST;
    process.env.ODOO_DEV_HOST_ALLOWLIST = "";
    try {
      expect((await reject("https://localhost:8069/")).reason).toBe("hostname");
    } finally {
      process.env.ODOO_DEV_HOST_ALLOWLIST = previous;
    }
  });

  it("allows an explicitly allowlisted development host", async () => {
    const safe = await assertSafeOdooUrl("https://odoo.example.test/");
    expect(safe.origin).toBe("https://odoo.example.test");
    expect(safe.port).toBe(443);
  });

  it("normalizes away path and trailing slash", async () => {
    const safe = await assertSafeOdooUrl("https://odoo.example.test/web/login?x=1");
    expect(safe.origin).toBe("https://odoo.example.test");
  });

  it("allows a public host on an Odoo port", async () => {
    const safe = await assertSafeOdooUrl("https://example.com:8069/");
    expect(safe.port).toBe(8069);
    expect(safe.addresses.length).toBeGreaterThan(0);
    // Every resolved address must have been verified public.
    for (const address of safe.addresses) expect(addressIsPrivate(address)).toBe(false);
  });
});
