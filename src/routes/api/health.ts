import { createFileRoute } from "@tanstack/react-router";

// Deployment healthcheck. Deliberately reveals nothing about any workspace:
// it reports that the process is up and whether the database is reachable.
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const { databaseConfigured, getPool } = await import("@/platform/db/pool");
        let database: "ok" | "unreachable" | "not_configured" = "not_configured";

        if (databaseConfigured()) {
          try {
            await getPool().query("SELECT 1");
            database = "ok";
          } catch {
            database = "unreachable";
          }
        }

        return Response.json(
          {
            ok: database !== "unreachable",
            service: "insightos",
            database,
            checkedAt: new Date().toISOString(),
          },
          {
            status: database === "unreachable" ? 503 : 200,
            headers: { "cache-control": "no-store" },
          },
        );
      },
    },
  },
});
