// What stands between an approved manifest and publication.
//
// The gate is deliberately strict — an unapproved financial definition blocks
// publication rather than warning about it. The risk of a strict gate is a
// deadlock: a blocker a reviewer has no way to clear. These tests pin the exit
// from every blocker, especially the one a reviewer reaches by agreeing with a
// policy's default answer without changing it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";
import {
  createManifestFromProposal,
  decideMapping,
  decidePolicy,
  listPolicies,
  publishBlockers,
  publishManifest,
} from "@/platform/semantic/repository";
import { REPORTING_POLICIES } from "@/platform/semantic/concepts";
import { closePool } from "@/platform/db/pool";
import type { WorkspaceContext } from "@/platform/contracts";
import type { MappingProposal } from "@/platform/semantic/contracts";

const ORG = "00000000-0000-4000-8000-00000000000b";
const WS = "00000000-0000-4000-8000-00000000001b";
const USER = "00000000-0000-4000-8000-0000000000b1";
const CONNECTION = "00000000-0000-4000-8000-0000000000b2";
const SNAPSHOT = "00000000-0000-4000-8000-0000000000b3";

const context: WorkspaceContext = {
  workspaceId: WS,
  organizationId: ORG,
  userId: USER,
  roles: ["workspace_owner"],
};

// Two fields is enough: one high-risk concept that always needs a human, and
// one cosmetic concept that does not.
const proposal: MappingProposal = {
  schemaSnapshotId: SNAPSHOT,
  entities: [
    {
      canonicalEntity: "invoice",
      odooModel: "account.move",
      primaryKey: "id",
      confidence: 1,
      evidence: [],
    },
  ],
  fields: [
    {
      canonicalField: "invoice.amountTotal",
      odooModel: "account.move",
      odooField: "amount_total",
      relationPath: [],
      confidence: 0.95,
      evidence: [],
      alternatives: [],
      riskLevel: "high",
      explanation: { ar: "", en: "" },
    },
    {
      canonicalField: "invoice.number",
      odooModel: "account.move",
      odooField: "name",
      relationPath: [],
      confidence: 0.9,
      evidence: [],
      alternatives: [],
      riskLevel: "low",
      explanation: { ar: "", en: "" },
    },
  ],
  unmapped: [],
};

let database: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  database = await startTestDatabase();
  process.env.DATABASE_URL = database.url;
  pool = new Pool({ connectionString: database.url, max: 4 });

  for (const id of ["0001_foundation", "0002_schema_discovery", "0003_semantic_layer"]) {
    await pool.query(
      await readFile(path.resolve(process.cwd(), "migrations", `${id}.up.sql`), "utf8"),
    );
  }

  await pool.query("INSERT INTO organizations (id,name,slug) VALUES ($1,'Beta','beta')", [ORG]);
  await pool.query("INSERT INTO users (id,email,name) VALUES ($1,'b@b.test','B')", [USER]);
  await pool.query(
    "INSERT INTO workspaces (id,organization_id,name,slug) VALUES ($1,$2,'Beta','production')",
    [WS, ORG],
  );
  await pool.query(
    "INSERT INTO memberships (user_id,organization_id,workspace_id,roles) VALUES ($1,$2,$3,ARRAY['workspace_owner'])",
    [USER, ORG, WS],
  );
  await pool.query(
    `INSERT INTO odoo_connections (id,workspace_id,base_url,database,login,status)
     VALUES ($1,$2,'https://beta.odoo.test','beta','a@b.test','connected')`,
    [CONNECTION, WS],
  );
  await pool.query(
    `INSERT INTO schema_snapshots (id,workspace_id,connection_id,content_hash,status)
     VALUES ($1,$2,$3,repeat('a',64),'ready')`,
    [SNAPSHOT, WS, CONNECTION],
  );
}, 120_000);

afterAll(async () => {
  await closePool().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

beforeEach(async () => {
  await pool.query("DELETE FROM semantic_manifests");
});

/** A fresh manifest with every field mapping approved, policies untouched. */
async function manifestWithApprovedMappings() {
  const manifest = await createManifestFromProposal(context, {
    snapshotId: SNAPSHOT,
    proposal,
  });
  for (const field of proposal.fields) {
    await decideMapping(context, manifest.id, {
      canonicalField: field.canonicalField,
      status: "approved",
    });
  }
  return manifest;
}

describe("publish gate", () => {
  it("blocks publication while the policy questions are unanswered", async () => {
    const manifest = await manifestWithApprovedMappings();

    const blockers = await publishBlockers(context, manifest.id);
    // Every mapping is approved, so nothing but the policies remains.
    expect(blockers.every((blocker) => blocker.kind === "policy")).toBe(true);
    expect(blockers).toHaveLength(REPORTING_POLICIES.length);

    const result = await publishManifest(context, manifest.id);
    expect(result.published).toBe(false);
  });

  it("approves a policy at the default answer the reviewer never changed", async () => {
    // The deadlock this guards against: a policy is seeded at its default and
    // the reviewer agrees with it. If approval could only be expressed by
    // *changing* the answer, agreeing with the default would be unsayable and
    // the manifest could never be published at all.
    const manifest = await manifestWithApprovedMappings();

    for (const policy of REPORTING_POLICIES) {
      await decidePolicy(context, manifest.id, policy.key, policy.defaultValue);
    }

    const policies = await listPolicies(context, manifest.id);
    for (const policy of policies) {
      const definition = REPORTING_POLICIES.find((p) => p.key === policy.policyKey);
      expect(policy.status, policy.policyKey).toBe("approved");
      // Approving must not quietly move the answer off what was shown.
      expect(policy.value, policy.policyKey).toBe(definition?.defaultValue);
    }

    expect(await publishBlockers(context, manifest.id)).toEqual([]);
    expect((await publishManifest(context, manifest.id)).published).toBe(true);
  });

  it("keeps a policy answer the reviewer did change", async () => {
    const manifest = await manifestWithApprovedMappings();
    const policy = REPORTING_POLICIES[0];
    const other = policy.options.find((option) => option.value !== policy.defaultValue)!;

    await decidePolicy(context, manifest.id, policy.key, other.value);

    const stored = (await listPolicies(context, manifest.id)).find(
      (p) => p.policyKey === policy.key,
    );
    expect(stored?.value).toBe(other.value);
    expect(stored?.status).toBe("approved");
  });

  it("still blocks on an unapproved financial mapping once policies are answered", async () => {
    const manifest = await createManifestFromProposal(context, {
      snapshotId: SNAPSHOT,
      proposal,
    });
    for (const policy of REPORTING_POLICIES) {
      await decidePolicy(context, manifest.id, policy.key, policy.defaultValue);
    }

    const blockers = await publishBlockers(context, manifest.id);
    expect(blockers).toEqual([
      {
        kind: "mapping",
        key: "invoice.amountTotal",
        reason: "financial_mapping_needs_approval",
      },
    ]);
    expect((await publishManifest(context, manifest.id)).published).toBe(false);
  });
});
