// Baseline invariant B-10 — the freshness defect found in audit §4.5.
//
// `markDashboardDatasetFailed` used to write `synced_at = now()` and apply it
// on conflict, so a FAILED refresh advanced the dataset's freshness timestamp
// while leaving stale rows in place. `/api/health` then reported that timestamp
// beside the failure, and the dashboard looked fresh when it was not.
//
// This asserts the SQL no longer updates synced_at on the failure path. It reads
// the source rather than exercising the query because the fix is precisely the
// absence of a clause, and the legacy module opens a pool on import.
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const SOURCE = path.resolve(process.cwd(), "src/lib/dashboard-db.server.ts");

async function markFailedStatement(): Promise<string> {
  const source = await readFile(SOURCE, "utf8");
  const start = source.indexOf("export async function markDashboardDatasetFailed");
  expect(start, "markDashboardDatasetFailed not found").toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end);
}

describe("B-10 · a failed dataset write does not advance freshness", () => {
  it("does not update synced_at in the failure path's ON CONFLICT clause", async () => {
    const body = await markFailedStatement();
    const onConflict = body.slice(body.indexOf("ON CONFLICT"));
    expect(onConflict).toContain("status = EXCLUDED.status");
    expect(onConflict).toContain("error = EXCLUDED.error");
    // The defect, restated as an assertion.
    expect(onConflict).not.toContain("synced_at = EXCLUDED.synced_at");
  });

  it("still records the failure status and message", async () => {
    const body = await markFailedStatement();
    expect(body).toContain("'failed'");
    expect(body).toContain("message.slice(0, 500)");
  });

  it("the success path does still set synced_at", async () => {
    // The corrected behaviour must not be over-applied: a successful publish is
    // exactly when freshness should move.
    const source = await readFile(SOURCE, "utf8");
    const start = source.indexOf("export async function writeDashboardDataset");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toContain("synced_at = EXCLUDED.synced_at");
  });
});

describe("stable keys are deterministic (B-8, B-9)", () => {
  // Restatement of stableKey() from dashboard-db.server.ts:153.
  function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  }

  const first = (row: Record<string, string>, keys: string[]): string => {
    for (const key of keys) {
      const value = row[key]?.trim();
      if (value) return value;
    }
    return "";
  };

  const stableKey = (dataset: string, row: Record<string, string>): string => {
    const explicit = first(row, ["__meta_key", "__odoo_id", "Order ID", "id"]);
    if (explicit) return `${dataset}:${explicit}`;
    return `${dataset}:sha256:${createHash("sha256").update(canonicalJson(row)).digest("hex")}`;
  };

  it("prefers an explicit id over the hash fallback", () => {
    expect(stableKey("crm", { __odoo_id: "42", name: "x" })).toBe("crm:42");
  });

  it("is stable across key ordering", () => {
    const a = stableKey("crm", { b: "2", a: "1" });
    const b = stableKey("crm", { a: "1", b: "2" });
    expect(a).toBe(b);
  });

  it("changes when the content changes", () => {
    expect(stableKey("crm", { a: "1" })).not.toBe(stableKey("crm", { a: "2" }));
  });

  it("scopes the key by dataset", () => {
    expect(stableKey("crm", { a: "1" })).not.toBe(stableKey("lost", { a: "1" }));
  });
});
