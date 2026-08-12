import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/dashboards/suggest")({
  server: {
    handlers: {
      // Turns a sentence into a draft dashboard.
      //
      // The result is a suggestion the customer edits, and it goes through the
      // same validator as everything else — natural language is a faster route
      // into the builder, not a second way to define a dashboard.
      POST: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        let payload: Record<string, unknown>;
        try {
          payload = await request.json();
        } catch {
          return errorResponse("Invalid JSON body.", 400);
        }

        const prompt = typeof payload.request === "string" ? payload.request.slice(0, 500) : "";
        if (prompt.trim().length < 3) return errorResponse("Describe what you want to see.", 400);

        try {
          const { metricMap, availableMetrics } = await import("@/platform/metrics/packs");
          const { activeGeneration } = await import("@/platform/sync/run");
          const { suggestDashboard } = await import("@/platform/dashboards/nl-builder");
          const { validateDashboard } = await import("@/platform/dashboards/validate");

          const known = metricMap();
          const generationId = await activeGeneration(guard.context);
          const available = new Set(
            generationId
              ? availableMetrics(
                  new Set([
                    "fact_lead",
                    "fact_order",
                    "fact_order_line",
                    "fact_invoice",
                    "fact_payment",
                  ]),
                ).map((metric) => metric.key)
              : [],
          );

          const suggestion = suggestDashboard({ request: prompt, known, available });
          const validation = validateDashboard(suggestion.definition, { known, available });

          return jsonResponse({
            ok: true,
            suggestion: validation.definition ?? suggestion.definition,
            matched: suggestion.matchedMetrics,
            unavailable: suggestion.unavailableMetrics,
            empty: suggestion.empty,
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
