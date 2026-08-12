// SSRF guard for the customer-supplied Odoo URL (THREAT_MODEL T3).
//
// The customer types this URL into an onboarding form, so the server will make
// a request to an address an attacker chose. Validating the hostname string is
// not enough — `evil.com` can resolve to 169.254.169.254 — so every resolved
// address is checked before the request is allowed.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(
    message: string,
    readonly reason:
      "scheme" | "credentials" | "port" | "hostname" | "private_address" | "resolve_failed",
  ) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const ALLOWED_PORTS = new Set([80, 443, 8069, 8071]);

/** Hosts permitted over plain http, for local development and tests only. */
function devHostAllowlist(): Set<string> {
  const raw = process.env.ODOO_DEV_HOST_ALLOWLIST?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // Unparseable is treated as unsafe.
  }
  const [a, b] = parts;
  return (
    a === 0 || //           0.0.0.0/8      "this network"
    a === 10 || //          10.0.0.0/8     private
    a === 127 || //         127.0.0.0/8    loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || //         169.254.0.0/16 link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12  private
    (a === 192 && b === 168) || //         192.168.0.0/16 private
    (a === 192 && b === 0) || //           192.0.0.0/24   IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224 //             224.0.0.0/4+   multicast and reserved
  );
}

function ipv6IsPrivate(ip: string): boolean {
  const address = ip.toLowerCase().split("%")[0]; // strip zone index
  if (address === "::" || address === "::1") return true; // unspecified, loopback
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms tunnel the v4 rules.
  const mapped = address.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  return (
    address.startsWith("fc") || // fc00::/7  unique local
    address.startsWith("fd") ||
    address.startsWith("fe8") || // fe80::/10 link-local
    address.startsWith("fe9") ||
    address.startsWith("fea") ||
    address.startsWith("feb") ||
    address.startsWith("ff") // ff00::/8  multicast
  );
}

export function addressIsPrivate(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return ipv4IsPrivate(ip);
  if (family === 6) return ipv6IsPrivate(ip);
  return true; // Not an IP at all — unsafe.
}

export interface SafeUrl {
  /** Normalized origin, no trailing slash. */
  origin: string;
  hostname: string;
  port: number;
  /** Every address the hostname resolved to, all verified public. */
  addresses: string[];
}

/**
 * Validates and resolves a customer-supplied Odoo base URL.
 *
 * Known residual risk: TOCTOU between this resolution and the actual connect
 * (SECURITY.md gap G-2). Closing it needs a pinned-IP dialer, which is Phase 3.
 */
export async function assertSafeOdooUrl(input: string): Promise<SafeUrl> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UnsafeUrlError("The Odoo URL is not a valid URL.", "hostname");
  }

  const devHosts = devHostAllowlist();
  // Node keeps the brackets on an IPv6 literal (`[::1]`), which would make
  // isIP() fail and send a loopback address down the DNS path instead of the
  // private-address check. Strip them before anything looks at the host.
  const hostname = url.hostname.toLowerCase().replace(/^\[(.+)\]$/, "$1");

  if (url.protocol !== "https:") {
    if (url.protocol === "http:" && devHosts.has(hostname)) {
      // Explicitly allowlisted development host.
    } else {
      throw new UnsafeUrlError("The Odoo URL must use https.", "scheme");
    }
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError("The Odoo URL must not contain credentials.", "credentials");
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    throw new UnsafeUrlError(`Port ${port} is not allowed. Use 443, 80, 8069 or 8071.`, "port");
  }

  if (!hostname || hostname.endsWith(".local") || hostname === "localhost") {
    if (!devHosts.has(hostname)) {
      throw new UnsafeUrlError("The Odoo hostname is not reachable.", "hostname");
    }
  }

  // A literal IP skips DNS but not the range check.
  if (isIP(hostname)) {
    if (addressIsPrivate(hostname) && !devHosts.has(hostname)) {
      throw new UnsafeUrlError("The Odoo URL points at a private address.", "private_address");
    }
    return { origin: url.origin, hostname, port, addresses: [hostname] };
  }

  // An explicitly allowlisted development host skips DNS: test and local hosts
  // frequently do not resolve at all, and the allowlist is an operator decision
  // made in the environment, not something a customer can influence.
  if (devHosts.has(hostname)) {
    return { origin: url.origin, hostname, port, addresses: [] };
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    throw new UnsafeUrlError("The Odoo hostname could not be resolved.", "resolve_failed");
  }
  if (!resolved.length) {
    throw new UnsafeUrlError("The Odoo hostname could not be resolved.", "resolve_failed");
  }

  // EVERY address must be public. One private answer among several is a
  // DNS-rebinding shape, so the whole hostname is refused.
  for (const { address } of resolved) {
    if (addressIsPrivate(address) && !devHosts.has(hostname)) {
      throw new UnsafeUrlError("The Odoo URL points at a private address.", "private_address");
    }
  }

  return {
    origin: url.origin,
    hostname,
    port,
    addresses: resolved.map((r) => r.address),
  };
}
