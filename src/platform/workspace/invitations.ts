// Workspace invitations.
//
// The token is a 256-bit random value shown to the inviter exactly once and
// stored only as a hash. An invitation grants access to a workspace, so a
// leaked database must not be a way in — the same reasoning that applies to a
// password.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withAdmin, withWorkspace } from "../db/pool";
import { requirePermission } from "./repository";
import type { Role, WorkspaceContext } from "../contracts";
import { ROLES } from "../contracts";

const EXPIRY_DAYS = 14;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface Invitation {
  id: string;
  email: string;
  roles: Role[];
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface CreatedInvitation extends Invitation {
  /** Shown once. Never retrievable afterwards, because only its hash is kept. */
  token: string;
}

export async function inviteMember(
  context: WorkspaceContext,
  email: string,
  roles: Role[],
): Promise<CreatedInvitation> {
  requirePermission(context, "membership.manage");

  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error("That is not a valid email address.");
  }

  // Roles come from the closed set. An invitation is a privilege grant, so an
  // unrecognised role is refused rather than stored and interpreted later.
  const valid = roles.filter((role): role is Role => (ROLES as readonly string[]).includes(role));
  if (!valid.length) throw new Error("At least one valid role is required.");
  // Only an owner may mint another owner.
  if (valid.includes("workspace_owner") && !context.roles.includes("workspace_owner")) {
    throw new Error("Only a workspace owner can invite another owner.");
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 86_400_000);

  return withWorkspace(context, async (client) => {
    // Re-inviting supersedes rather than accumulating: several live tokens for
    // one person would each remain a way in.
    await client.query(
      `UPDATE workspace_invitations SET status = 'revoked'
        WHERE workspace_id = $1 AND lower(email) = $2 AND status = 'pending'`,
      [context.workspaceId, normalized],
    );

    const { rows } = await client.query(
      `INSERT INTO workspace_invitations
         (workspace_id, email, roles, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, email, roles, status, expires_at, created_at`,
      [
        context.workspaceId,
        normalized,
        valid,
        hashToken(token),
        context.userId,
        expiresAt.toISOString(),
      ],
    );

    const row = rows[0];
    return {
      id: String(row.id),
      email: String(row.email),
      roles: row.roles as Role[],
      status: String(row.status),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      createdAt: new Date(String(row.created_at)).toISOString(),
      token,
    };
  });
}

export async function listInvitations(context: WorkspaceContext): Promise<Invitation[]> {
  requirePermission(context, "membership.manage");

  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT id, email, roles, status, expires_at, created_at
         FROM workspace_invitations
        WHERE workspace_id = $1 AND status = 'pending'
        ORDER BY created_at DESC`,
      [context.workspaceId],
    );
    // The token hash is deliberately not selected: there is nothing useful a
    // caller can do with it, and every extra place it travels is a risk.
    return rows.map((row) => ({
      id: String(row.id),
      email: String(row.email),
      roles: row.roles as Role[],
      status: String(row.status),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      createdAt: new Date(String(row.created_at)).toISOString(),
    }));
  });
}

export async function revokeInvitation(
  context: WorkspaceContext,
  invitationId: string,
): Promise<boolean> {
  requirePermission(context, "membership.manage");

  return withWorkspace(context, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE workspace_invitations SET status = 'revoked'
        WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`,
      [context.workspaceId, invitationId],
    );
    return (rowCount ?? 0) > 0;
  });
}

export interface AcceptResult {
  accepted: boolean;
  workspaceId?: string;
  reason?: "not_found" | "expired" | "already_member" | "email_mismatch";
}

/**
 * Redeems an invitation.
 *
 * Runs as admin because the invitee has no membership yet, so there is no
 * workspace context to run under — accepting one is precisely the act of
 * acquiring it.
 *
 * The token is compared by hash in constant time. The email must match the one
 * invited, so a forwarded link does not let a different person in.
 */
export async function acceptInvitation(
  userId: string,
  userEmail: string,
  token: string,
): Promise<AcceptResult> {
  const tokenHash = hashToken(token);

  return withAdmin(async (client) => {
    const { rows } = await client.query(
      `SELECT id, workspace_id, email, roles, token_hash, expires_at, status
         FROM workspace_invitations WHERE token_hash = $1`,
      [tokenHash],
    );
    const invitation = rows[0];
    if (!invitation || invitation.status !== "pending")
      return { accepted: false, reason: "not_found" };

    // Constant-time even though the lookup was by hash: the comparison should
    // not be the one place timing leaks.
    const presented = Buffer.from(tokenHash);
    const stored = Buffer.from(String(invitation.token_hash));
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      return { accepted: false, reason: "not_found" };
    }

    if (new Date(String(invitation.expires_at)) < new Date()) {
      await client.query("UPDATE workspace_invitations SET status='expired' WHERE id=$1", [
        invitation.id,
      ]);
      return { accepted: false, reason: "expired" };
    }

    if (String(invitation.email).toLowerCase() !== userEmail.trim().toLowerCase()) {
      // A forwarded invitation must not admit whoever opened it.
      return { accepted: false, reason: "email_mismatch" };
    }

    const workspaceId = String(invitation.workspace_id);
    const { rows: workspaceRows } = await client.query<{ organization_id: string }>(
      "SELECT organization_id FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    if (!workspaceRows[0]) return { accepted: false, reason: "not_found" };

    const existing = await client.query(
      "SELECT 1 FROM memberships WHERE user_id = $1 AND workspace_id = $2",
      [userId, workspaceId],
    );
    if (existing.rows.length) {
      await client.query(
        "UPDATE workspace_invitations SET status='accepted', accepted_by=$1, accepted_at=now() WHERE id=$2",
        [userId, invitation.id],
      );
      return { accepted: false, reason: "already_member", workspaceId };
    }

    await client.query(
      `INSERT INTO memberships (user_id, organization_id, workspace_id, roles)
       VALUES ($1,$2,$3,$4)`,
      [userId, workspaceRows[0].organization_id, workspaceId, invitation.roles],
    );
    await client.query(
      "UPDATE workspace_invitations SET status='accepted', accepted_by=$1, accepted_at=now() WHERE id=$2",
      [userId, invitation.id],
    );

    return { accepted: true, workspaceId };
  });
}
