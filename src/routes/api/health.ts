import { createFileRoute } from "@tanstack/react-router";

// Deployment healthcheck. Deliberately reveals nothing about any workspace:
// it reports that the process is up and whether the database is reachable.
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const { databaseConfigured, getPool } = await import("@/platform/db/pool");
        let database: "ok" | "unreachable" | "not_configured" = "not_configured";
        let schema: "ok" | "missing" | "unknown" = "unknown";

        if (databaseConfigured()) {
          try {
            const result = await getPool().query<{ ready: boolean }>(`
              SELECT to_regclass('public.users') IS NOT NULL
                 AND to_regclass('public.accounts') IS NOT NULL
                 AND to_regclass('public.sessions') IS NOT NULL
                 AND to_regclass('public.verifications') IS NOT NULL
                 AND to_regclass('public.workspaces') IS NOT NULL AS ready
            `);
            database = "ok";
            schema = result.rows[0]?.ready ? "ok" : "missing";
          } catch {
            database = "unreachable";
          }
        }

        const healthy = database === "ok" && schema === "ok";
        return Response.json(
          {
            ok: healthy,
            service: "insightos",
            database,
            schema,
            release: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
            checkedAt: new Date().toISOString(),
          },
          {
            status: healthy ? 200 : 503,
            headers: { "cache-control": "no-store" },
          },
        );
      },
    },
  },
});
