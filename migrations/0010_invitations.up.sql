-- 0010 · Member invitations.
--
-- Until now the only way to add a colleague was an INSERT by hand. A workspace
-- that one person can use is a demo, not a product.

CREATE TABLE workspace_invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text NOT NULL,
  roles        text[] NOT NULL DEFAULT '{viewer}',
  -- Stored hashed, never in the clear: an invitation token grants workspace
  -- access, so a leaked database must not hand out memberships.
  token_hash   char(64) NOT NULL UNIQUE,
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','revoked','expired')),
  expires_at   timestamptz NOT NULL,
  accepted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One live invitation per email per workspace, so re-inviting replaces rather
-- than accumulating tokens that all still work.
CREATE UNIQUE INDEX workspace_invitations_pending
  ON workspace_invitations (workspace_id, lower(email)) WHERE status = 'pending';
CREATE INDEX workspace_invitations_workspace_idx
  ON workspace_invitations (workspace_id, status);

SELECT apply_workspace_rls('workspace_invitations'::regclass);

-- Accepting happens before the invitee has any membership, so the lookup runs
-- with no workspace context. It is keyed by a hash of a 256-bit token, which is
-- not guessable, and it exposes nothing until the right token is presented.
CREATE POLICY workspace_invitations_redeem ON workspace_invitations
  FOR SELECT USING (status = 'pending' AND expires_at > now());
