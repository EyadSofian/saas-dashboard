import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/data-health")({
  server: {
    handlers: {
      // Distinguishes the four honest states: never synced, current success,
      // stale last-good, and a current failed attempt sitting beside healthy
      // data. `lastSuccessAt` advances only on success — the corrected form of
      // the defect found in audit §4.5.
      GET: async ({ request }) => {
        const { requireWorkspace, jsonResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { listHealth } = await import("@/platform/health");
          const domains = await listHealth(guard.context);
          return jsonResponse({
            ok: true,
            checkedAt: new Date().toISOString(),
            domains,
            summary: {
              never: domains.filter((d) => d.status === "never").length,
              success: domains.filter((d) => d.status === "success").length,
              stale: domains.filter((d) => d.status === "stale").length,
              failed: domains.filter((d) => d.status === "failed").length,
            },
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
