import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/audit")({
  server: {
    handlers: {
      // Append-only audit trail. Metadata was redacted on write, so nothing
      // here can contain a secret value even if a caller has full permission.
      GET: async ({ request }) => {
        const { requireWorkspace, jsonResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { requirePermission } = await import("@/platform/workspace/repository");
          requirePermission(guard.context, "audit.read");

          const { listAudit } = await import("@/platform/audit/log");
          const limit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
          return jsonResponse({
            ok: true,
            events: await listAudit(guard.context, Number.isFinite(limit) ? limit : 100),
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
