// Canonical serialization and hashing.
//
// Lifted verbatim from `dashboard-db.server.ts` so a value hashes identically on
// both sides of the migration: the legacy stable-key path and the new snapshot
// dedupe must never disagree about what "the same object" means.
import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Lowercase hex SHA-256 of the canonical form. Used for snapshot dedupe. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** The version stamped onto every persisted contract. Bumping it is a migration. */
export const CONTRACT_VERSION = 1;
