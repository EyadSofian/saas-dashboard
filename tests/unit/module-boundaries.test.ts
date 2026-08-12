// Structural invariants — ADR-0006 boundaries and the tenancy naming rule.
//
// These are enforced by review and by this test rather than by a package
// manager, because the monorepo split is deliberately deferred (ADR-0006).
import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

async function filesUnder(dir: string, extensions = [".ts", ".tsx"]): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

const importsFrom = (source: string): string[] =>
  [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);

describe("ADR-0006 · platform module boundaries", () => {
  it("no platform module imports from routes or components", async () => {
    const files = await filesUnder(path.join(ROOT, "src", "platform"));
    expect(files.length).toBeGreaterThan(10);

    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of importsFrom(await readFile(file, "utf8"))) {
        if (/^(@\/)?(src\/)?(routes|components)\//.test(specifier)) {
          violations.push(`${path.relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("contracts/ imports nothing from other platform modules", async () => {
    const files = await filesUnder(path.join(ROOT, "src", "platform", "contracts"));
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of importsFrom(await readFile(file, "utf8"))) {
        // Relative imports inside contracts/ are fine; reaching up is not.
        if (specifier.startsWith("../") || /@\/platform\/(?!contracts)/.test(specifier)) {
          violations.push(`${path.relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("odoo/ does not depend on db/ or auth/, so it stays testable without a database", async () => {
    const files = await filesUnder(path.join(ROOT, "src", "platform", "odoo"));
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of importsFrom(await readFile(file, "utf8"))) {
        if (/(^|\/)(db|auth)(\/|$)/.test(specifier.replace("@/platform/", ""))) {
          violations.push(`${path.relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("ADR-0004 · workspace_id is the only isolation key", () => {
  it("no tenant_id / tenantId identifier exists in source or migrations", async () => {
    const files = [
      ...(await filesUnder(path.join(ROOT, "src"))),
      ...(await filesUnder(path.join(ROOT, "migrations"), [".sql"])),
      ...(await filesUnder(path.join(ROOT, "scripts"), [".ts", ".mjs"])),
    ];

    // Identifiers only. The rule bans a second isolation KEY, not the word — a
    // comment explaining why `tenant_id` does not exist is exactly the kind of
    // documentation we want, so comments are stripped before scanning.
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    const offenders: string[] = [];
    for (const file of files) {
      const source = file.endsWith(".sql")
        ? (await readFile(file, "utf8")).replace(/^\s*--.*$/gm, "")
        : stripComments(await readFile(file, "utf8"));
      if (/\btenant_?[Ii]d\b/.test(source)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every RLS-protected table declares workspace_id NOT NULL", async () => {
    const files = (await filesUnder(path.join(ROOT, "migrations"), [".sql"])).filter((f) =>
      f.endsWith(".up.sql"),
    );

    // Collect the tables each migration hands to apply_workspace_rls, then
    // check those same tables carry the isolation key in their own definition.
    // Relying on a join to establish ownership is exactly the mistake this
    // guards against.
    const protectedTables = new Set<string>();
    const definitions = new Map<string, string>();

    for (const file of files) {
      const sql = await readFile(file, "utf8");
      for (const match of sql.matchAll(/'(\w+)'::regclass/g)) protectedTables.add(match[1]);
      for (const match of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
        definitions.set(match[1], match[2]);
      }
    }

    expect(protectedTables.size).toBeGreaterThan(15);
    for (const table of protectedTables) {
      const body = definitions.get(table);
      expect(body, `${table} is RLS-protected but was never defined`).toBeDefined();
      // `PRIMARY KEY` implies NOT NULL, so a table keyed by workspace_id alone
      // satisfies the invariant just as strictly as an explicit declaration.
      expect(body, `${table} allows a null workspace_id`).toMatch(
        /workspace_id\s+uuid\s+(NOT NULL|PRIMARY KEY)/,
      );
    }
  });

  it("every migration has a matching down script", async () => {
    const entries = await readdir(path.join(ROOT, "migrations"));
    const ups = entries.filter((f) => f.endsWith(".up.sql"));
    expect(ups.length).toBeGreaterThan(0);
    for (const up of ups) {
      expect(entries).toContain(up.replace(".up.sql", ".down.sql"));
    }
  });
});

describe("tests never contact production", () => {
  it("no test or fixture hardcodes a non-test hostname", async () => {
    const files = await filesUnder(path.join(ROOT, "tests"));
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      // Skip any userinfo (`user:pass@`) so the host itself is what gets checked.
      for (const match of source.matchAll(/https?:\/\/(?:[^/@\s"']*@)?\[?([a-z0-9.:-]+)\]?/gi)) {
        const host = match[1].toLowerCase();
        const allowed =
          host.endsWith(".test") ||
          host.endsWith(".invalid") ||
          host === "localhost" ||
          // example.com / example.net are IANA-reserved for documentation.
          /(^|\.)example\.(com|net|org)$/.test(host) ||
          /^[\d.]+$/.test(host) ||
          host.includes(":"); // IPv6 literal
        if (!allowed) offenders.push(`${path.relative(ROOT, file)}: ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
