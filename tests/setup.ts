// Global test setup.
//
// Two jobs: give every test a deterministic environment, and make it impossible
// for a test to reach production by accident.

// A random-looking but fixed 32-byte key. Test-only; never used anywhere else.
process.env.SECRET_STORE_ROOT_KEY =
  process.env.SECRET_STORE_ROOT_KEY ?? "Zq4vN8xKp2mR7tYw3sJhBc5dFgLnQaEuIoPzXvCbTyU=";
process.env.SECRET_STORE_ADAPTER = "local-aes-gcm";

// The mock Odoo host. Explicitly allowlisted so the SSRF guard permits it
// without a DNS lookup, since `.test` never resolves.
//
// Deliberately NOT including 127.0.0.1: the loopback rejection is one of the
// behaviours under test, and an allowlist entry would quietly disable it.
process.env.ODOO_DEV_HOST_ALLOWLIST = "odoo.example.test";

process.env.FEATURE_WORKSPACES = "1";
process.env.FEATURE_ODOO_DISCOVERY = "1";
process.env.NODE_ENV = "test";

// Production database URLs must never be reachable from a test run. If
// DATABASE_URL is set to anything that is not obviously local, drop it: an
// integration test skipping is infinitely better than a test writing to
// production.
const url = process.env.DATABASE_URL ?? "";
if (url && !/localhost|127\.0\.0\.1|::1/.test(url)) {
  delete process.env.DATABASE_URL;
}
