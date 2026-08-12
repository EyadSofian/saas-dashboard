import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/mapping/publish")({
  server: {
    handlers: {
      // Publishes the manifest, or explains exactly what is blocking it.
      // Publication is refused — not warned about — while a financial mapping
      // or a reporting policy is unapproved.
      POST: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { currentManifest, publishManifest } =
            await import("@/platform/semantic/repository");
          const manifest = await currentManifest(guard.context);
          if (!manifest) return errorResponse("No manifest under review.", 409);

          const result = await publishManifest(guard.context, manifest.id);
          if (!result.published) {
            return jsonResponse({ ok: false, blockers: result.blockers }, 409);
          }

          const { writeAudit } = await import("@/platform/audit/log");
          await writeAudit(guard.context, {
            action: "mapping.published",
            targetType: "semantic_manifest",
            targetId: manifest.id,
            metadata: { version: manifest.version },
          });

          return jsonResponse({ ok: true, manifest: { ...manifest, status: "published" } });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
