# Runbook — secret storage

How customer Odoo credentials are protected, what the current arrangement does
not protect against, and when it must be replaced.

---

## Current adapter: `railway-aes-gcm`

**Status: accepted for the first 1–3 customers. Must be replaced before scaling.**

AES-256-GCM envelope encryption. A fresh 96-bit IV per secret, a 128-bit
authentication tag, and additional authenticated data binding each ciphertext to
its workspace, connection, purpose and key version — so a ciphertext copied into
another row fails to decrypt rather than quietly succeeding.

The cryptography is the same a KMS adapter would use. The difference is entirely
in where the root key lives.

### What this does protect against

- A stolen database dump. Ciphertext without the root key is useless.
- A ciphertext moved between rows or workspaces. The AAD binding breaks it.
- Tampering. A modified ciphertext or tag fails authentication and is refused.
- Accidental exposure through the application: API responses, logs, errors,
  audit records, exports and AI payloads are all covered by tests that scan for
  the plaintext.

### What this does not protect against — stated plainly

**Anyone who can read the process environment can decrypt every stored
credential.** That set includes:

- anyone with deploy access to the Railway project,
- anyone who can open a shell on the running service,
- Railway itself.

A KMS moves the key behind an API that logs every use and can revoke access
without a redeploy. This cannot. There is also no audit trail of decryptions:
if a key were misused, nothing would record it.

### Why it is acceptable now

For the first customers, the operator, the deployer and the founder are the same
person. The blast radius is understood and the list of people who could abuse
this is one name long. Waiting for KMS before onboarding anyone would trade a
real, understood risk for an indefinite delay.

### The trigger to replace it

Move to KMS or Vault when **any** of these becomes true:

- Someone gains deploy access who should not see customer credentials.
- A customer asks how their credentials are protected. (The honest answer above
  is not one most buyers accept.)
- More than three customers are connected.
- A compliance questionnaire, a security review, or an enterprise deal appears.

The `SecretStore` interface already exists and this adapter implements it, so
the replacement is one new class plus a rotation pass — not a redesign.

---

## Configuration

```bash
openssl rand -base64 32
```

```bash
APP_ENV=production
SECRET_STORE_ADAPTER=railway-aes-gcm
ALLOW_RAILWAY_SECRET_STORE_IN_PRODUCTION=1
SECRET_STORE_ROOT_KEY=<the 32-byte key from above>
```

Both `SECRET_STORE_ADAPTER=railway-aes-gcm` and
`ALLOW_RAILWAY_SECRET_STORE_IN_PRODUCTION=1` are required in production. Neither
has a plausible default, so nobody arrives here by copying an example. The
second string is searchable, so an audit later can find every deployment where
someone accepted this.

The adapter reports `isProductionGrade: false` and always will. The override is
an operator accepting a documented risk, not the adapter claiming to be
something it is not.

### ⚠ Losing the root key

**Every stored Odoo credential becomes permanently undecryptable.** There is no
recovery path — that is what "encrypted" means.

Store it somewhere you can recover it from that is *not only* Railway: a
password manager entry, or a sealed envelope. Recovery from this is re-entering
every customer's Odoo API key by hand, which means contacting every customer.

---

## Rotating the root key

Rotation works without downtime because the adapter accepts two keys at once.

1. Generate a new key: `openssl rand -base64 32`
2. Set **both** variables and redeploy:
   ```bash
   SECRET_STORE_ROOT_KEY=<new key>
   SECRET_STORE_ROOT_KEY_PREVIOUS=<the old key>
   ```
   At this point everything still works: new secrets are written under the new
   key, and existing ones still decrypt under the old one.
3. Re-encrypt existing secrets. Each stored secret carries a `keyId`, so the
   ones still on the old key are identifiable, and `reEncrypt` migrates them
   without the plaintext leaving the process.
4. Once nothing reports `needsReEncryption`, remove
   `SECRET_STORE_ROOT_KEY_PREVIOUS` and redeploy.

### Why key versioning matters

Each secret is stamped with a `keyId` derived from a hash of the key — enough to
identify it, never enough to reveal it.

Without it, changing the key turns every decrypt into a generic "authentication
failed", indistinguishable from a corrupted row or a tampered ciphertext, and an
operator would spend the outage looking in the wrong place. With it, the error
says exactly what happened:

> This secret was encrypted under key `v1-8f3a2c91b04d`, which is not
> configured. Set `SECRET_STORE_ROOT_KEY_PREVIOUS` to that key and run the
> rotation, or re-enter the credential.

---

## Fail-closed behaviour

Every one of these refuses rather than degrading:

| Condition | Result |
| --- | --- |
| `SECRET_STORE_ROOT_KEY` missing | Refuses to start the store |
| Key not valid base64, or not 32 bytes | Refuses, naming the actual length |
| Key is one repeated byte (a placeholder) | Refuses |
| `SECRET_STORE_ROOT_KEY_PREVIOUS` equals the current key | Refuses — rotation would be a no-op |
| Production without the explicit override | Refuses to store a credential |
| Ciphertext, tag or AAD does not authenticate | Refuses to decrypt |
| Secret written by a different adapter | Refuses to decrypt |

A short key is never padded and a missing key never falls back to a default.

---

## What the tests prove

`tests/security/secret-never-leaks.test.ts` stores a distinctive canary value
through the real code path into a real PostgreSQL, then:

- **scans every text, varchar and jsonb column of every table** for it — not
  just the columns someone thought to check;
- asserts it is absent from the connection API response, the workspace export,
  audit records, error messages and redacted log structures;
- asserts it never appears in the AI mapping prompt or the copilot's prompt and
  tool surface;
- exercises every fail-closed condition in the table above;
- covers rotation end to end, including that the old key can no longer read a
  migrated secret.

### One residual risk this surfaced

Value-based redaction only covers secrets registered with `withSecretRedacted`.
A future developer who writes a decrypted credential into a field *not* named
like a secret, *outside* a redaction scope, would leak it into that record.

The mitigation is that every route holding a decrypted key wraps its whole body
in `withSecretRedacted`, so anything raised or recorded inside is covered
regardless of field name. Any new code path that decrypts a credential must do
the same.
