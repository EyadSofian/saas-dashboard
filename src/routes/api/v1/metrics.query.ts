import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/metrics/query")({
  server: {
    handlers: {
      // Answers a metric question from approved definitions only.
      //
      // The request names metric KEYS, never SQL and never columns to
      // aggregate. Anything not in the catalog comes back as unavailable with a
      // reason rather than as an error or, worse, a zero.
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

        const metricKeys = Array.isArray(payload.metricKeys)
          ? payload.metricKeys.filter((k): k is string => typeof k === "string").slice(0, 24)
          : [];
        if (!metricKeys.length) return errorResponse("metricKeys is required.", 400);

        try {
          const { executeQuery } = await import("@/platform/metrics/engine");
          const { metricMap } = await import("@/platform/metrics/packs");
          const { activeGeneration } = await import("@/platform/sync/run");

          const range = payload.dateRange as { from?: string; to?: string } | undefined;
          const isDate = (value: unknown): value is string =>
            typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

          const values = await executeQuery(
            guard.context,
            {
              metricKeys,
              dimensions: Array.isArray(payload.dimensions)
                ? payload.dimensions.filter((d): d is string => typeof d === "string").slice(0, 4)
                : undefined,
              // Half-open [from, to). The UI may show an inclusive end date but
              // converts it before asking.
              dateRange:
                range && isDate(range.from) && isDate(range.to)
                  ? { from: range.from, to: range.to }
                  : undefined,
            },
            {
              definitions: metricMap(),
              generationId: await activeGeneration(guard.context),
            },
          );

          return jsonResponse({ ok: true, values });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
