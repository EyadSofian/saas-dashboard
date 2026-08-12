// railway-aes-gcm — the interim production secret store.
//
// WHAT THIS IS
// AES-256-GCM envelope encryption with the root key held in a platform
// environment variable (Railway's secret store). It is the same cryptography a
// KMS adapter would use; the difference is entirely in where the key lives and
// who can reach it.
//
// WHY IT IS NOT PRODUCTION-GRADE, STATED PLAINLY
// Anyone who can read the process environment can decrypt every stored
// credential. That set includes anyone with deploy access, anyone who can open
// a shell on the service, and the platform itself. A KMS moves the key behind
// an API that logs every use and can revoke access without redeploying; this
// cannot. It also cannot rotate without a re-encryption pass, and it leaves no
// audit trail of decryptions.
//
// So this adapter reports `isProductionGrade: false` and always will. Using it
// in production requires the operator to set a second, deliberately awkward
// environment variable — the point being that nobody arrives here by accident
// or by copying a default.
//
// ACCEPTED FOR: the first 1–3 customers, where the operator, the deployer and
// the founder are the same person and the blast radius is understood.
// MUST BE REPLACED BEFORE: hiring anyone with deploy access who should not see
// customer credentials, or onboarding a customer who asks how their key is
// protected. See docs/runbooks/secret-store.md.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SecretRef, SecretStore, StoredSecret } from "./index";
import { SecretStoreError } from "./index";

export const RAILWAY_ADAPTER_ID = "railway-aes-gcm";

/**
 * Identifies which key encrypted a secret, without revealing the key.
 *
 * This matters more than it looks. Without it, changing the root key turns
 * every decrypt into a generic "authentication failed" — indistinguishable from
 * a corrupted ciphertext or a tampered row. With it, the error says exactly
 * what happened: this was encrypted under a key you no longer have.
 */
export function deriveKeyId(rootKey: Buffer): string {
  return `v1-${createHash("sha256").update(rootKey).digest("hex").slice(0, 12)}`;
}

function parseRootKey(raw: string | undefined, variable: string): Buffer {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new SecretStoreError(
      `${variable} is not set. Generate one with: openssl rand -base64 32`,
      "not_configured",
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(value, "base64");
  } catch {
    throw new SecretStoreError(`${variable} is not valid base64.`, "invalid_key");
  }

  if (key.length !== 32) {
    // Fail closed on a short key rather than padding it: a 16-byte key silently
    // accepted would halve the security of every secret stored under it.
    throw new SecretStoreError(
      `${variable} must decode to exactly 32 bytes, got ${key.length}. ` +
        `Generate one with: openssl rand -base64 32`,
      "invalid_key",
    );
  }

  // A key of all one byte is what you get from a placeholder or a bad copy.
  const first = key[0];
  if (key.every((byte) => byte === first)) {
    throw new SecretStoreError(
      `${variable} looks like a placeholder rather than a random key.`,
      "invalid_key",
    );
  }

  return key;
}

/** AAD binds a ciphertext to its row, so moving it between rows breaks it. */
function aad(ref: SecretRef, keyId: string): Buffer {
  return Buffer.from(`v1|${ref.workspaceId}|${ref.connectionId}|${ref.purpose}|${keyId}`, "utf8");
}

export interface RailwaySecretStoreOptions {
  rootKey?: string;
  /**
   * The key being rotated away from. When present, a secret encrypted under it
   * still decrypts, and is reported as needing re-encryption.
   */
  previousRootKey?: string;
}

export class RailwaySecretStore implements SecretStore {
  readonly adapterId = RAILWAY_ADAPTER_ID;

  /**
   * Deliberately false, permanently.
   *
   * Claiming otherwise would make the production guard meaningless and would
   * let a future reader believe the key is protected in a way it is not. The
   * override below is how an operator accepts this risk knowingly.
   */
  readonly isProductionGrade = false;

  readonly keyId: string;
  private readonly rootKey: Buffer;
  private readonly previousKey: Buffer | null;
  private readonly previousKeyId: string | null;

  constructor(options: RailwaySecretStoreOptions = {}) {
    this.rootKey = parseRootKey(
      options.rootKey ?? process.env.SECRET_STORE_ROOT_KEY,
      "SECRET_STORE_ROOT_KEY",
    );
    this.keyId = deriveKeyId(this.rootKey);

    const previous = options.previousRootKey ?? process.env.SECRET_STORE_ROOT_KEY_PREVIOUS;
    if (previous?.trim()) {
      this.previousKey = parseRootKey(previous, "SECRET_STORE_ROOT_KEY_PREVIOUS");
      this.previousKeyId = deriveKeyId(this.previousKey);
      if (this.previousKeyId === this.keyId) {
        throw new SecretStoreError(
          "SECRET_STORE_ROOT_KEY_PREVIOUS is the same as the current key; rotation would be a no-op.",
          "invalid_key",
        );
      }
    } else {
      this.previousKey = null;
      this.previousKeyId = null;
    }
  }

  async put(ref: SecretRef, plaintext: string): Promise<StoredSecret> {
    assertRailwayAllowed(this);
    return this.encrypt(ref, plaintext, this.rootKey, this.keyId);
  }

  private encrypt(ref: SecretRef, plaintext: string, key: Buffer, keyId: string): StoredSecret {
    const iv = randomBytes(12); // 96-bit, fresh per encryption
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(ref, keyId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    return {
      adapterId: this.adapterId,
      keyId,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  async get(ref: SecretRef, stored: StoredSecret): Promise<string> {
    if (stored.adapterId !== this.adapterId) {
      throw new SecretStoreError(
        `This secret was written by adapter "${stored.adapterId}", not "${this.adapterId}".`,
        "decrypt_failed",
      );
    }

    // Current key first, then the key being rotated away from.
    const candidates: Array<{ key: Buffer; keyId: string }> = [
      { key: this.rootKey, keyId: this.keyId },
    ];
    if (this.previousKey && this.previousKeyId) {
      candidates.push({ key: this.previousKey, keyId: this.previousKeyId });
    }

    const matching = candidates.filter((candidate) => candidate.keyId === stored.keyId);

    if (!matching.length) {
      // The specific, actionable error a bare auth failure would have hidden.
      throw new SecretStoreError(
        `This secret was encrypted under key ${stored.keyId}, which is not configured. ` +
          `Set SECRET_STORE_ROOT_KEY_PREVIOUS to that key and run the rotation, or re-enter the credential.`,
        "decrypt_failed",
      );
    }

    for (const candidate of matching) {
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          candidate.key,
          Buffer.from(stored.iv, "base64"),
        );
        decipher.setAAD(aad(ref, stored.keyId));
        decipher.setAuthTag(Buffer.from(stored.authTag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(stored.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Try the next candidate; the throw below covers exhaustion.
      }
    }

    // Tampered ciphertext, a ciphertext moved to another row, or a corrupted
    // tag. The reason is not distinguished to the caller on purpose.
    throw new SecretStoreError("Stored credential could not be decrypted.", "decrypt_failed");
  }

  async rotate(ref: SecretRef, plaintext: string): Promise<StoredSecret> {
    assertRailwayAllowed(this);
    return this.encrypt(ref, plaintext, this.rootKey, this.keyId);
  }

  /** True when this secret is still under the old key and should be re-encrypted. */
  needsReEncryption(stored: StoredSecret): boolean {
    return stored.keyId !== this.keyId;
  }

  /**
   * Re-encrypts one secret under the current key.
   *
   * The plaintext exists only inside this call. It is never returned, logged, or
   * held anywhere the caller can reach, so a rotation pass cannot become the
   * thing that leaks what it was protecting.
   */
  async reEncrypt(ref: SecretRef, stored: StoredSecret): Promise<StoredSecret> {
    if (!this.needsReEncryption(stored)) return stored;
    const plaintext = await this.get(ref, stored);
    try {
      return this.encrypt(ref, plaintext, this.rootKey, this.keyId);
    } finally {
      // Node strings are immutable, so this cannot scrub memory. It is a marker
      // of intent for whoever reads this next, and a reminder that a real KMS
      // never hands the plaintext to the application at all.
    }
  }
}

/**
 * The production gate for this adapter.
 *
 * Two variables, both required, neither with a plausible default. An operator
 * has to write `ALLOW_RAILWAY_SECRET_STORE_IN_PRODUCTION=1` on purpose, and
 * that string is searchable — so an audit later can find every deployment where
 * someone accepted this.
 */
export function railwayOverrideEnabled(): boolean {
  return (
    (process.env.SECRET_STORE_ADAPTER ?? "").trim() === RAILWAY_ADAPTER_ID &&
    (process.env.ALLOW_RAILWAY_SECRET_STORE_IN_PRODUCTION ?? "").trim() === "1"
  );
}

function assertRailwayAllowed(store: SecretStore): void {
  // Imported lazily to avoid a cycle: index.ts constructs this class.
  const appEnv = (process.env.APP_ENV ?? "").trim().toLowerCase();
  const isProduction =
    appEnv === "production" || (appEnv === "" && process.env.NODE_ENV === "production");

  if (!isProduction) return;
  if (railwayOverrideEnabled()) return;

  throw new SecretStoreError(
    `Refusing to store a customer credential: adapter "${store.adapterId}" is not ` +
      `production-grade. Set ALLOW_RAILWAY_SECRET_STORE_IN_PRODUCTION=1 to accept the risk ` +
      `documented in docs/runbooks/secret-store.md, or configure a KMS adapter.`,
    "production_guard",
  );
}
