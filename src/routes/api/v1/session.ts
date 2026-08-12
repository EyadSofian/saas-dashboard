import { createFileRoute } from "@tanstack/react-router";

// The signed-in user plus the workspaces they may enter.
//
// This is the one legitimate pre-workspace query, so it runs with user context
// only: the RLS policy on `workspaces` exposes exactly the rows the user holds
// a membership for, and nothing else.
export const Route = createFileRoute("/api/v1/session")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const noStore = { headers: { "cache-control": "no-store" } };
        const { databaseConfigured } = await import("@/platform/db/pool");
        if (!databaseConfigured()) {
          return Response.json(
            { ok: false, error: "The platform database is not configured." },
            { status: 503, ...noStore },
          );
        }

        const { getSessionUser } = await import("@/platform/auth");
        const user = await getSessionUser(request);
        if (!user) {
          return Response.json(
            { ok: false, user: null, workspaces: [] },
            { status: 401, ...noStore },
          );
        }

        try {
          const { listWorkspacesForUser } = await import("@/platform/workspace/repository");
          return Response.json(
            { ok: true, user, workspaces: await listWorkspacesForUser(user.id) },
            noStore,
          );
        } catch {
          return Response.json(
            { ok: false, error: "Could not load workspaces." },
            { status: 500, ...noStore },
          );
        }
      },
    },
  },
});
