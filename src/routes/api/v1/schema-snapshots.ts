import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/schema-snapshots")({
  server: {
    handlers: {
      // Read-only snapshot viewer.
      //   ?model=<name>  that model's fields
      //   otherwise      the snapshot header and its model list
      //
      // Field labels and help text are customer-controlled strings, returned
      // here as data for display. Nothing downstream may treat them as
      // instructions.
      GET: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { latestSnapshot, snapshotFields, snapshotModels } =
            await import("@/platform/workspace/repository");
          const snapshot = await latestSnapshot(guard.context);
          if (!snapshot) return errorResponse("No schema snapshot yet.", 404);

          const model = new URL(request.url).searchParams.get("model")?.trim();
          if (model) {
            return jsonResponse({
              ok: true,
              snapshotId: snapshot.id,
              model,
              fields: await snapshotFields(guard.context, snapshot.id, model),
            });
          }

          return jsonResponse({
            ok: true,
            snapshot,
            models: await snapshotModels(guard.context, snapshot.id),
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
