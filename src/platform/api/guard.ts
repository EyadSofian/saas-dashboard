// Route guard for every /api/v1 endpoint.
//
// The order matters and is deliberate:
//   1. session     — not signed in is 401
//   2. membership  — signed in but not a member is 403
//   3. permission  — a member without the role is 403
//
// The workspace id arrives from the client, so step 2 is what actually decides:
// membership is the authority, the header is only a request.
import { getSessionUser } from "../auth";
import { resolveWorkspaceContext } from "../workspace/repository";
import { ForbiddenError } from "../workspace/repository";
import { databaseConfigured } from "../db/pool";
import type { WorkspaceContext } from "../contracts";
import { redactSecrets, safeErrorMessage } from "../audit/redact";
import { reportError } from "../observability/errors";

export const WORKSPACE_HEADER = "x-workspace-id";

export function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(redactSecrets(data), {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function errorResponse(
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return jsonResponse({ ok: false, error: message, ...extra }, status);
}

export interface GuardSuccess {
  ok: true;
  context: WorkspaceContext;
  userId: string;
}
export interface GuardFailure {
  ok: false;
  response: Response;
}

export async function requireWorkspace(request: Request): Promise<GuardSuccess | GuardFailure> {
  if (!databaseConfigured()) {
    return { ok: false, response: errorResponse("The platform database is not configured.", 503) };
  }

  const user = await getSessionUser(request);
  if (!user) return { ok: false, response: errorResponse("Authentication required.", 401) };

  const url = new URL(request.url);
  const requested =
    request.headers.get(WORKSPACE_HEADER)?.trim() || url.searchParams.get("workspaceId")?.trim();
  if (!requested) {
    return { ok: false, response: errorResponse("A workspace must be selected.", 400) };
  }

  const context = await resolveWorkspaceContext(user.id, requested);
  if (!context) {
    // Deliberately identical to the response for a workspace that does not
    // exist: a non-member must not be able to probe for valid workspace ids.
    return { ok: false, response: errorResponse("Workspace not found.", 403) };
  }

  return { ok: true, context, userId: user.id };
}

/** Maps a thrown error to a response without leaking internals or secrets. */
export function handleRouteError(
  error: unknown,
  context: { workspaceId?: string; operation?: string } = {},
): Response {
  if (error instanceof ForbiddenError) {
    // A permission refusal is the system working, not an incident.
    return errorResponse("You do not have permission to do this.", 403);
  }
  // Fire-and-forget: an outage at the tracker must not turn a handled 500 into
  // an unhandled one, or add latency to a request already going badly.
  reportError(error, context);
  return errorResponse(safeErrorMessage(error, 200), 500);
}
