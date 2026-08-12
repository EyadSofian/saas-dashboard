// SecretStore — ADR-0002, THREAT_MODEL T2.
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalAesGcmSecretStore,
  SecretStoreError,
  assertProductionSafe,
  getSecretStore,
  setSecretStore,
  type SecretRef,
} from "@/platform/secrets";

const ROOT_KEY = "Zq4vN8xKp2mR7tYw3sJhBc5dFgLnQaEuIoPzXvCbTyU=";
const API_KEY = "odoo-api-key-super-secret-value-2026";

const ref: SecretRef = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  connectionId: "22222222-2222-4222-8222-222222222222",
  purpose: "odoo_api_key",
};

afterEach(() => setSecretStore(null));

describe("LocalAesGcmSecretStore", () => {
  const store = new LocalAesGcmSecretStore(ROOT_KEY);

  it("round-trips a secret", async () => {
    const stored = await store.put(ref, API_KEY);
    expect(await store.get(ref, stored)).toBe(API_KEY);
  });

  it("never stores the plaintext anywhere in the record", async () => {
    const stored = await store.put(ref, API_KEY);
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
    expect(stored.ciphertext).not.toContain(API_KEY);
  });

  it("produces different ciphertext each time (fresh IV)", async () => {
    const a = await store.put(ref, API_KEY);
    const b = await store.put(ref, API_KEY);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    // ...but both still decrypt.
    expect(await store.get(ref, a)).toBe(API_KEY);
    expect(await store.get(ref, b)).toBe(API_KEY);
  });

  it("rejects tampered ciphertext", async () => {
    const stored = await store.put(ref, API_KEY);
    const bytes = Buffer.from(stored.ciphertext, "base64");
    bytes[0] ^= 0xff;
    await expect(
      store.get(ref, { ...stored, ciphertext: bytes.toString("base64") }),
    ).rejects.toThrow(SecretStoreError);
  });

  it("rejects a tampered auth tag", async () => {
    const stored = await store.put(ref, API_KEY);
    const tag = Buffer.from(stored.authTag, "base64");
    tag[0] ^= 0xff;
    await expect(store.get(ref, { ...stored, authTag: tag.toString("base64") })).rejects.toThrow(
      SecretStoreError,
    );
  });

  // This is the isolation-relevant property: encryption alone protects bytes at
  // rest, but AAD binding makes a stolen ciphertext useless in another tenant.
  it("refuses to decrypt a ciphertext moved to another workspace", async () => {
    const stored = await store.put(ref, API_KEY);
    const otherWorkspace = { ...ref, workspaceId: "33333333-3333-4333-8333-333333333333" };
    await expect(store.get(otherWorkspace, stored)).rejects.toThrow(/could not be decrypted/i);
  });

  it("refuses to decrypt a ciphertext moved to another connection", async () => {
    const stored = await store.put(ref, API_KEY);
    const otherConnection = { ...ref, connectionId: "44444444-4444-4444-8444-444444444444" };
    await expect(store.get(otherConnection, stored)).rejects.toThrow(/could not be decrypted/i);
  });

  it("refuses to decrypt a secret written by a different adapter", async () => {
    const stored = await store.put(ref, API_KEY);
    await expect(store.get(ref, { ...stored, adapterId: "kms" })).rejects.toThrow(SecretStoreError);
  });

  it("rotates to new ciphertext that decrypts to the new value", async () => {
    const original = await store.put(ref, API_KEY);
    const rotated = await store.rotate(ref, "rotated-key-value-98765");
    expect(rotated.ciphertext).not.toBe(original.ciphertext);
    expect(await store.get(ref, rotated)).toBe("rotated-key-value-98765");
    // The old ciphertext still decrypts to the old value until it is destroyed.
    expect(await store.get(ref, original)).toBe(API_KEY);
  });
});

describe("root key validation", () => {
  it("refuses a missing key", () => {
    expect(() => new LocalAesGcmSecretStore("")).toThrow(/not configured/i);
  });

  it("refuses a key of the wrong length", () => {
    expect(() => new LocalAesGcmSecretStore(Buffer.alloc(16).toString("base64"))).toThrow(
      /32 bytes/,
    );
  });

  it("refuses a well-known all-zero test key", () => {
    expect(() => new LocalAesGcmSecretStore(Buffer.alloc(32).toString("base64"))).toThrow(
      /well-known test value/i,
    );
  });
});

describe("production guard", () => {
  it("refuses to store a customer credential under a development adapter", async () => {
    const store = new LocalAesGcmSecretStore(ROOT_KEY);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => assertProductionSafe(store)).toThrow(/not production-grade/i);
      await expect(store.put(ref, API_KEY)).rejects.toThrow(/not production-grade/i);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("allows a production-grade adapter", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        assertProductionSafe({
          adapterId: "kms",
          isProductionGrade: true,
        } as never),
      ).not.toThrow();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe("getSecretStore", () => {
  it("refuses an unknown adapter rather than falling back to the weakest one", () => {
    setSecretStore(null);
    const previous = process.env.SECRET_STORE_ADAPTER;
    process.env.SECRET_STORE_ADAPTER = "typo-adapter";
    try {
      expect(() => getSecretStore()).toThrow(/Unknown SECRET_STORE_ADAPTER/);
    } finally {
      process.env.SECRET_STORE_ADAPTER = previous;
      setSecretStore(null);
    }
  });
});
