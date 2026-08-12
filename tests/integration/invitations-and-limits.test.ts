// Invitations and rate limits, against a real PostgreSQL.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";
import {
  acceptInvitation,
  inviteMember,
  listInvitations,
  revokeInvitation,
} from "@/platform/workspace/invitations";
import { consumeRateLimit, rateLimitBudget } from "@/platform/api/rate-limit";
import { closePool } from "@/platform/db/pool";
import type { WorkspaceContext } from "@/platform/contracts";

const ORG = "00000000-0000-4000-8000-00000000000a";
const WS = "00000000-0000-4000-8000-00000000001a";
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const INVITEE = "00000000-0000-4000-8000-0000000000b1";
const OUTSIDER = "00000000-0000-4000-8000-0000000000c1";

const owner: WorkspaceContext = {
  workspaceId: WS,
  organizationId: ORG,
  userId: OWNER,
  roles: ["workspace_owner"],
};
const analyst: WorkspaceContext = { ...owner, userId: OUTSIDER, roles: ["analyst"] };

let database: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  database = await startTestDatabase();
  process.env.DATABASE_URL = database.url;
  pool = new Pool({ connectionString: database.url, max: 4 });

  for (const id of [
    "0001_foundation",
    "0002_schema_discovery",
    "0003_semantic_layer",
    "0004_canonical_and_dashboards",
    "0005_durable_jobs_and_watermarks",
    "0006_reconciliation",
    "0007_dashboard_builder",
    "0008_copilot",
    "0009_plans_and_lifecycle",
    "0010_invitations",
  ]) {
    await pool.query(
      await readFile(path.resolve(process.cwd(), "migrations", `${id}.up.sql`), "utf8"),
    );
  }

  await pool.query("INSERT INTO organizations (id,name,slug) VALUES ($1,'Alpha','alpha')", [ORG]);
  for (const [id, email] of [
    [OWNER, "owner@alpha.test"],
    [INVITEE, "colleague@alpha.test"],
    [OUTSIDER, "outsider@other.test"],
  ] as const) {
    await pool.query("INSERT INTO users (id,email,name) VALUES ($1,$2,'X')", [id, email]);
  }
  await pool.query(
    "INSERT INTO workspaces (id,organization_id,name,slug) VALUES ($1,$2,'Alpha','production')",
    [WS, ORG],
  );
  await pool.query(
    "INSERT INTO memberships (user_id,organization_id,workspace_id,roles) VALUES ($1,$2,$3,ARRAY['workspace_owner'])",
    [OWNER, ORG, WS],
  );
}, 120_000);

afterAll(async () => {
  await closePool().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

beforeEach(async () => {
  await pool.query("DELETE FROM workspace_invitations");
  await pool.query("DELETE FROM usage_events");
  await pool.query("DELETE FROM memberships WHERE user_id <> $1", [OWNER]);
});

describe("inviting", () => {
  it("returns a token once and stores only its hash", async () => {
    const invitation = await inviteMember(owner, "colleague@alpha.test", ["analyst"]);
    expect(invitation.token.length).toBeGreaterThan(30);

    const { rows } = await pool.query("SELECT token_hash FROM workspace_invitations");
    // An invitation grants workspace access, so a leaked database must not be
    // a way in — the same reasoning as a password.
    expect(rows[0].token_hash).not.toBe(invitation.token);
    expect(rows[0].token_hash).toHaveLength(64);
  });

  it("never returns the hash when listing", async () => {
    await inviteMember(owner, "colleague@alpha.test", ["analyst"]);
    const listed = await listInvitations(owner);
    expect(JSON.stringify(listed)).not.toContain("token");
  });

  it("refuses a caller without membership.manage", async () => {
    await expect(inviteMember(analyst, "x@alpha.test", ["viewer"])).rejects.toThrow(
      /Missing permission/,
    );
  });

  it("lets only an owner mint another owner", async () => {
    const dataAdmin: WorkspaceContext = { ...owner, roles: ["data_admin"] };
    // data_admin holds membership.manage in no role map, so this is refused
    // before the owner-specific check — but the check exists for the case where
    // a future role does hold it.
    await expect(inviteMember(dataAdmin, "x@alpha.test", ["workspace_owner"])).rejects.toThrow();
    await expect(
      inviteMember(owner, "colleague@alpha.test", ["workspace_owner"]),
    ).resolves.toBeTruthy();
  });

  it("refuses an unrecognised role", async () => {
    await expect(
      inviteMember(owner, "colleague@alpha.test", ["superuser" as never]),
    ).rejects.toThrow(/valid role/);
  });

  it("refuses a malformed email", async () => {
    await expect(inviteMember(owner, "not-an-email", ["viewer"])).rejects.toThrow(/valid email/);
  });

  it("supersedes a previous invitation rather than accumulating live tokens", async () => {
    const first = await inviteMember(owner, "colleague@alpha.test", ["viewer"]);
    const second = await inviteMember(owner, "colleague@alpha.test", ["analyst"]);

    // The old token must stop working, or every re-invite leaves another way in.
    expect((await acceptInvitation(INVITEE, "colleague@alpha.test", first.token)).accepted).toBe(
      false,
    );
    expect((await acceptInvitation(INVITEE, "colleague@alpha.test", second.token)).accepted).toBe(
      true,
    );
  });
});

describe("accepting", () => {
  it("grants the invited roles", async () => {
    const invitation = await inviteMember(owner, "colleague@alpha.test", ["analyst"]);
    const result = await acceptInvitation(INVITEE, "colleague@alpha.test", invitation.token);
    expect(result.accepted).toBe(true);

    const { rows } = await pool.query("SELECT roles FROM memberships WHERE user_id = $1", [
      INVITEE,
    ]);
    expect(rows[0].roles).toEqual(["analyst"]);
  });

  it("refuses a forwarded invitation opened by someone else", async () => {
    // The link travels by email and gets forwarded. The address is what decides.
    const invitation = await inviteMember(owner, "colleague@alpha.test", ["analyst"]);
    const result = await acceptInvitation(OUTSIDER, "outsider@other.test", invitation.token);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("email_mismatch");

    const { rows } = await pool.query("SELECT 1 FROM memberships WHERE user_id = $1", [OUTSIDER]);
    expect(rows).toHaveLength(0);
  });

  it("refuses an unknown token", async () => {
    const result = await acceptInvitation(INVITEE, "colleague@alpha.test", "not-a-real-token");
    expect(result.reason).toBe("not_found");
  });

  it("refuses an expired invitation and marks it so", async () => {
    const invitation = await inviteMember(owner, "colleague@alpha.test", ["analyst"]);
    await pool.query("UPDATE workspace_invitations SET expires_at = now() - interval '1 day'");

    expect((await acceptInvitation(INVITEE, "colleague@alpha.test", invitation.token)).reason).toBe(
      "expired",
    );
    const { rows } = await pool.query("SELECT status FROM workspace_invitations");
    expect(rows[0].status).toBe("expired");
  });

  it("cannot be replayed after acceptance", async () => {
    const invitation = await inviteMember(owner, "colleague@alpha.test", ["analyst"]);
    await acceptInvitation(INVITEE, "colleague@alpha.test", invitation.token);
    // A token that still works after use is a permanent back door.
    expect((await acceptInvitation(INVITEE, "colleague@alpha.test", invitation.token)).reason).toBe(
      "not_found",
    );
  });

  it("refuses a revoked invitation", async () => {
    const invitation = await inviteMember(owner, "colleague@alpha.test", ["analyst"]);
    const listed = await listInvitations(owner);
    expect(await revokeInvitation(owner, listed[0].id)).toBe(true);

    expect((await acceptInvitation(INVITEE, "colleague@alpha.test", invitation.token)).reason).toBe(
      "not_found",
    );
  });
});

describe("rate limits", () => {
  it("allows up to the budget and then refuses", async () => {
    const budget = rateLimitBudget("export")!;
    for (let i = 0; i < budget.max; i++) {
      expect((await consumeRateLimit(owner, "export")).allowed, `call ${i + 1}`).toBe(true);
    }

    const refused = await consumeRateLimit(owner, "export");
    expect(refused.allowed).toBe(false);
    // Retry when the oldest event ages out, so a client that waits exactly this
    // long actually succeeds.
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(budget.windowSeconds);
  });

  it("counts each operation separately", async () => {
    const budget = rateLimitBudget("export")!;
    for (let i = 0; i < budget.max; i++) await consumeRateLimit(owner, "export");

    // Exhausting exports must not stop someone opening a dashboard.
    expect((await consumeRateLimit(owner, "metric_query")).allowed).toBe(true);
  });

  it("is scoped per workspace, so one customer cannot exhaust another", async () => {
    const other = "00000000-0000-4000-8000-00000000002a";
    // A distinct slug: (organization_id, slug) is unique, so reusing
    // 'production' would silently create nothing and the FK below would fail.
    await pool.query(
      "INSERT INTO workspaces (id,organization_id,name,slug) VALUES ($1,$2,'Beta','beta') ON CONFLICT DO NOTHING",
      [other, ORG],
    );

    const budget = rateLimitBudget("export")!;
    for (let i = 0; i < budget.max; i++) await consumeRateLimit(owner, "export");
    expect((await consumeRateLimit(owner, "export")).allowed).toBe(false);

    const neighbour: WorkspaceContext = { ...owner, workspaceId: other };
    expect((await consumeRateLimit(neighbour, "export")).allowed).toBe(true);
  });

  it("ignores events older than the window", async () => {
    const budget = rateLimitBudget("export")!;
    for (let i = 0; i < budget.max; i++) await consumeRateLimit(owner, "export");
    expect((await consumeRateLimit(owner, "export")).allowed).toBe(false);

    await pool.query(
      `UPDATE usage_events SET occurred_at = now() - make_interval(secs => $1) WHERE kind = 'rate:export'`,
      [budget.windowSeconds + 60],
    );
    expect((await consumeRateLimit(owner, "export")).allowed).toBe(true);
  });

  it("refuses an unknown operation rather than allowing it unlimited", async () => {
    expect((await consumeRateLimit(owner, "nonsense" as never)).allowed).toBe(false);
  });

  it("gives every budget a stated rationale", () => {
    // A limit without a reason becomes a number nobody dares change.
    for (const key of [
      "discovery",
      "sync",
      "connection_test",
      "copilot",
      "ai_mapping",
      "metric_query",
      "export",
    ] as const) {
      expect(rateLimitBudget(key)?.rationale.length).toBeGreaterThan(20);
    }
  });
});
