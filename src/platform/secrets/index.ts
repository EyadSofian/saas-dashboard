// SecretStore — ADR-0002.
//
// Nothing is ever persisted in plaintext. The local adapter is explicitly
// development-grade, and a production guard refuses to let it hold customer
// credentials.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export interface SecretRef {
  workspaceId: string;
  connectionId: string;
  purpose: string;
}

export interface StoredSecret {
  adapterId: string;
  keyId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface SecretStore {
  readonly adapterId: string;
  readonly isProductionGrade: boolean;
  put(ref: SecretRef, plaintext: string): Promise<StoredSecret>;
  get(ref: SecretRef, stored: StoredSecret): Promise<string>;
  rotate(ref: SecretRef, plaintext: string): Promise<StoredSecret>;
}

export class SecretStoreError extends Error {
  constructor(
    message: string,
    readonly kind: "not_configured" | "production_guard" | "decrypt_failed" | "invalid_key",
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}

/**
 * Additional authenticated data. This is the control that makes envelope
 * encryption participate in tenant isolation rather than merely protecting
 * bytes at rest: a ciphertext copied into another workspace's row has different
 * AAD and fails the GCM tag check instead of quietly decrypting.
 */
function aad(ref: SecretRef, keyId: string): Buffer {
  return Buffer.from(`v1|${ref.workspaceId}|${ref.connectionId}|${ref.purpose}|${keyId}`, "utf8");
}

const WEAK_KEYS = new Set([
  Buffer.alloc(32).toString("base64"),
  Buffer.alloc(32, 1).toString("base64"),
]);

export class LocalAesGcmSecretStore implements SecretStore {
  readonly adapterId = "local-aes-gcm";
  /** Development-grade by definition: the root key lives in an env var. */
  readonly isProductionGrade = false;
  readonly keyId: string;
  private readonly rootKey: Buffer;

  constructor(rootKeyBase64?: string, keyId = "v1") {
    const raw = (rootKeyBase64 ?? process.env.SECRET_STORE_ROOT_KEY ?? "").trim();
    if (!raw) {
      throw new SecretStoreError(
        "SECRET_STORE_ROOT_KEY is not configured (32 random bytes, base64).",
        "not_configured",
      );
    }
    let key: Buffer;
    try {
      key = Buffer.from(raw, "base64");
    } catch {
      throw new SecretStoreError("SECRET_STORE_ROOT_KEY is not valid base64.", "invalid_key");
    }
    if (key.length !== 32) {
      throw new SecretStoreError(
        `SECRET_STORE_ROOT_KEY must decode to 32 bytes, got ${key.length}.`,
        "invalid_key",
      );
    }
    if (WEAK_KEYS.has(key.toString("base64"))) {
      throw new SecretStoreError(
        "SECRET_STORE_ROOT_KEY is a well-known test value; generate a random key.",
        "invalid_key",
      );
    }
    this.rootKey = key;
    this.keyId = keyId;
  }

  async put(ref: SecretRef, plaintext: string): Promise<StoredSecret> {
    assertProductionSafe(this);
    const iv = randomBytes(12); // 96-bit IV, fresh per encryption
    const cipher = createCipheriv("aes-256-gcm", this.rootKey, iv);
    cipher.setAAD(aad(ref, this.keyId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      adapterId: this.adapterId,
      keyId: this.keyId,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  async get(ref: SecretRef, stored: StoredSecret): Promise<string> {
    if (stored.adapterId !== this.adapterId) {
      throw new SecretStoreError(
        `Secret was written by adapter ${stored.adapterId}, not ${this.adapterId}.`,
        "decrypt_failed",
      );
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.rootKey,
        Buffer.from(stored.iv, "base64"),
      );
      decipher.setAAD(aad(ref, stored.keyId));
      decipher.setAuthTag(Buffer.from(stored.authTag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Tampered ciphertext, wrong workspace/connection AAD, or a rotated key.
      // The reason is deliberately not distinguished to the caller.
      throw new SecretStoreError("Stored credential could not be decrypted.", "decrypt_failed");
    }
  }

  async rotate(ref: SecretRef, plaintext: string): Promise<StoredSecret> {
    return this.put(ref, plaintext);
  }
}

/**
 * Which deployment this is, for the purpose of holding real customer secrets.
 *
 * Deliberately NOT `NODE_ENV`. Every PaaS — Railway included — sets
 * `NODE_ENV=production` to get optimized builds, which says nothing about
 * whether the deployment holds a real customer's ERP credentials. Conflating
 * the two leaves only two bad options: block staging entirely, or weaken the
 * guard everywhere.
 *
 * Unset means production, so a deployment that never sets it is protected.
 */
export type AppEnv = "production" | "staging" | "development";

export function appEnv(): AppEnv {
  const raw = (process.env.APP_ENV ?? "").trim().toLowerCase();
  if (raw === "staging" || raw === "development") return raw;
  if (raw === "production") return "production";
  // Nothing set: fall back to NODE_ENV, and treat anything non-local as
  // production. Fail-closed — an unlabelled deployment is assumed to be real.
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

/**
 * Fail-closed production guard. Development convenience must not become the
 * production posture by accident, so this refuses the write rather than warning.
 *
 * Staging is allowed to use the local adapter because staging holds test
 * credentials by definition. If a staging deployment is pointed at a real
 * customer's Odoo, that is a process failure this guard cannot catch — which is
 * exactly why the production default is the strict one.
 */
export function assertProductionSafe(store: SecretStore): void {
  if (appEnv() === "production" && !store.isProductionGrade) {
    throw new SecretStoreError(
      `Refusing to store a customer credential: adapter "${store.adapterId}" is not ` +
        `production-grade. Configure a production SecretStore adapter (ADR-0002), or ` +
        `set APP_ENV=staging if this deployment only ever holds test credentials.`,
      "production_guard",
    );
  }
}

let cached: SecretStore | null = null;

export function getSecretStore(): SecretStore {
  if (cached) return cached;
  const adapter = (process.env.SECRET_STORE_ADAPTER ?? "local-aes-gcm").trim();
  switch (adapter) {
    case "local-aes-gcm":
      cached = new LocalAesGcmSecretStore();
      return cached;
    default:
      // A misspelled adapter name must not silently fall back to the weakest one.
      throw new SecretStoreError(
        `Unknown SECRET_STORE_ADAPTER "${adapter}". Known adapters: local-aes-gcm.`,
        "not_configured",
      );
  }
}

/** Test seam; also used when rotating the root key. */
export function setSecretStore(store: SecretStore | null): void {
  cached = store;
}

/** Constant-time compare for ingest-style shared secrets. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
