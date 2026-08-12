# ADR-0002 — SecretStore interface with AES-256-GCM local adapter

**Status:** Accepted · 2026-08-12

## Context

The product must store customer Odoo API keys. An Odoo API key inherits its
integration user's full permissions, so it is the most sensitive asset in the
system (threat model T2).

Today credentials come from `process.env.ODOO_API_KEY` — a single global
credential for a single tenant. That cannot hold customer secrets.

A real KMS is the right production answer, but this milestone is explicitly
local-only: no external accounts, no paid services, no production mutation. The
design must therefore make the safe production path mandatory *without* being
able to build it yet.

## Decision

Define a **`SecretStore` interface** and ship one adapter now, with a guard that
prevents that adapter from ever being the production posture.

```ts
interface SecretStore {
  readonly adapterId: string;
  readonly isProductionGrade: boolean;
  put(ref: SecretRef, plaintext: string): Promise<StoredSecret>;
  get(ref: SecretRef): Promise<string>;
  rotate(ref: SecretRef, plaintext: string): Promise<StoredSecret>;
  destroy(ref: SecretRef): Promise<void>;
}
```

**`LocalAesGcmSecretStore`** (local/staging only):

- AES-256-GCM envelope encryption; root key from `SECRET_STORE_ROOT_KEY`
  (32 bytes, base64), which must not be a well-known test value.
- Fresh random 96-bit IV per encryption; 128-bit auth tag.
- **AAD binds the ciphertext to `workspace_id` + `connection_id` + key version**,
  so a ciphertext copied into another workspace's row fails to decrypt rather
  than silently succeeding. This is the control that makes envelope encryption
  participate in tenant isolation instead of merely protecting bytes at rest.
- Versioned `keyId` so rotation is possible without re-encrypting everything at
  once.
- Ciphertext is stored in `connection_secret_refs`, never in
  `odoo_connections`, so the connection row can be selected freely by UI code
  with no risk of leaking material.

**Production guard.** If `NODE_ENV === "production"` and the configured adapter
reports `isProductionGrade === false`, `put()` and `rotate()` **throw**. The
product refuses to store a customer credential rather than storing it under a
development-grade key. Fail-closed.

## Alternatives considered

**Plaintext column.** Rejected outright.

**`pgcrypto` in the database.** Rejected: the key ends up in SQL text, query
logs and backups; the database becomes both the lock and the key.

**Railway environment variables per customer.** This is the current
single-tenant mechanism. Rejected as the multi-tenant answer: it does not scale
past a handful of customers, has no per-secret audit or rotation, and requires a
deploy to change a credential.

**Adopt AWS KMS / Vault now.** The correct production design and the planned
adapter. Rejected *for this milestone only* because it requires creating external
paid infrastructure, which is outside the authorized scope. The interface exists
precisely so this is an adapter swap.

## Consequences

**Positive.** Nothing is ever persisted in plaintext; local development needs no
cloud account; the AAD binding turns encryption into an isolation control; the
production guard makes the unsafe path impossible to ship by accident.

**Negative.** The root key lives in an environment variable, so anyone with
process environment access plus database access can decrypt — acceptable for
local/staging, unacceptable for production, which is exactly what the guard
encodes. Rotating the root key requires a re-encryption pass (interface
supports it; no migration tooling written yet).

**Planned.** `KmsSecretStore` (AWS KMS, `isProductionGrade: true`) in Phase 3,
with per-workspace data keys under a shared CMK and the same AAD binding.

## Verification

`tests/unit/secret-store.test.ts` — round-trip; tampered ciphertext rejected;
tampered AAD (wrong workspace/connection) rejected; corrupted tag rejected;
rotation produces new ciphertext and the old plaintext stays retrievable until
destroyed; production guard refuses the local adapter.
`tests/security/secret-redaction.test.ts` — a known key value never appears in
any API response, log line, audit row or error string.
