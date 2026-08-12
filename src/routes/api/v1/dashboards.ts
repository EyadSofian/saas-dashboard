import { createFileRoute } from "@tanstack/react-router";

/** Metrics this workspace can actually answer, from what it has synced. */
async function availableFor(context: import("@/platform/contracts").WorkspaceContext) {
  const { activeGeneration } = await import("@/platform/sync/run");
  const { availableMetrics } = await import("@/platform/metrics/packs");
  const { withWorkspace } = await import("@/platform/db/pool");

  const generationId = await activeGeneration(context);
  if (!generationId) return { generationId: null, available: new Set<string>() };

  // A table with no rows in this generation cannot answer anything, so the
  // builder must not offer metrics that read it.
  const populated = await withWorkspace(context, async (client) => {
    const tables = ["fact_lead", "fact_order", "fact_order_line", "fact_invoice", "fact_payment"];
    const found = new Set<string>();
    for (const table of tables) {
      const { rows } = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM ${table} WHERE workspace_id = $1 AND generation_id = $2
         ) AS present`,
        [context.workspaceId, generationId],
      );
      if (rows[0]?.present) found.add(table);
    }
    return found;
  });

  return {
    generationId,
    available: new Set(availableMetrics(populated).map((metric) => metric.key)),
  };
}

export const Route = createFileRoute("/api/v1/dashboards")({
  server: {
    handlers: {
      // Dashboards, plus the metric catalog the builder may choose from.
      GET: async ({ request }) => {
        const { requireWorkspace, jsonResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { listDashboards, listSavedViews, seedTemplates } =
            await import("@/platform/dashboards/repository");
          const { ALL_METRICS } = await import("@/platform/metrics/packs");

          // A brand-new workspace gets the starter dashboards on first look
          // rather than an empty page it has to build its way out of.
          await seedTemplates(guard.context).catch(() => 0);

          const [dashboards, savedViews, { available, generationId }] = await Promise.all([
            listDashboards(guard.context),
            listSavedViews(guard.context),
            availableFor(guard.context),
          ]);

          return jsonResponse({
            ok: true,
            dashboards,
            savedViews,
            generationId,
            metrics: ALL_METRICS.map((metric) => ({
              key: metric.key,
              label: metric.label,
              unit: metric.unit,
              allowedDimensions: metric.allowedDimensions,
              formula: metric.formula,
              available: available.has(metric.key),
            })),
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },

      // Saves a draft. Validated before it is stored, so an invalid dashboard
      // never reaches the database and cannot be rendered from it later.
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

        const key = typeof payload.key === "string" ? payload.key.trim() : "";
        if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(key)) {
          return errorResponse(
            "A dashboard key must be lowercase letters, digits and dashes.",
            400,
          );
        }

        try {
          const { validateDashboard } = await import("@/platform/dashboards/validate");
          const { metricMap } = await import("@/platform/metrics/packs");
          const { available } = await availableFor(guard.context);

          const validation = validateDashboard(payload.definition, {
            known: metricMap(),
            available,
          });
          if (!validation.definition) {
            return errorResponse("The dashboard definition is not valid.", 400, {
              issues: validation.issues,
            });
          }
          // Unavailable metrics are reported but do not block saving a draft:
          // building a dashboard before the data lands is a normal order of work.
          const blocking = validation.issues.filter(
            (issue) => issue.reason !== "metric_unavailable",
          );
          if (blocking.length) {
            return errorResponse("The dashboard definition is not valid.", 400, {
              issues: blocking,
            });
          }

          const { saveDraft } = await import("@/platform/dashboards/repository");
          const record = await saveDraft(guard.context, {
            key,
            title: payload.title as { ar: string; en: string } | undefined,
            audience: typeof payload.audience === "string" ? payload.audience : undefined,
            definition: validation.definition,
          });

          return jsonResponse({ ok: true, dashboard: record, issues: validation.issues }, 201);
        } catch (error) {
          return handleRouteError(error);
        }
      },

      // Publish, roll back, or set the default.
      PATCH: async ({ request }) => {
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

        const key = typeof payload.key === "string" ? payload.key : "";
        const action = typeof payload.action === "string" ? payload.action : "";
        if (!key) return errorResponse("key is required.", 400);

        try {
          const repository = await import("@/platform/dashboards/repository");
          const { writeAudit } = await import("@/platform/audit/log");

          if (action === "publish") {
            const record = await repository.publishDashboard(guard.context, key);
            if (!record) return errorResponse("There is no draft to publish.", 409);
            await writeAudit(guard.context, {
              action: "dashboard.published",
              targetType: "dashboard",
              targetId: key,
              metadata: { version: record.version },
            });
            return jsonResponse({ ok: true, dashboard: record });
          }

          if (action === "rollback") {
            const version = Number(payload.version);
            if (!Number.isInteger(version)) return errorResponse("version is required.", 400);
            // Rollback republishes an old definition as a new version rather
            // than rewriting history, so the audit stays readable.
            const record = await repository.rollbackDashboard(guard.context, key, version);
            if (!record) return errorResponse("That version does not exist.", 404);
            await writeAudit(guard.context, {
              action: "dashboard.rolled_back",
              targetType: "dashboard",
              targetId: key,
              metadata: { restoredFrom: version, newVersion: record.version },
            });
            return jsonResponse({ ok: true, dashboard: record });
          }

          if (action === "set_default") {
            await repository.setDefaultDashboard(guard.context, key);
            return jsonResponse({ ok: true });
          }

          return errorResponse("Unknown action.", 400);
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
