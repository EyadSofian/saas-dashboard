// The copilot's entire capability surface.
//
// Four read-only tools over approved metrics. There is deliberately no tool
// that runs SQL, names a table, reads a record, or takes a workspace id — the
// workspace comes from the server's session-resolved context and the model
// never sees it, so "which workspace?" is not a question it can get wrong or be
// talked into answering differently.
//
// The model cannot reach anything the dashboard cannot. That is the whole
// design: the copilot is a different way to ask the same questions, not a
// second, looser path to the data.
import type { WorkspaceContext } from "../contracts";
import { executeQuery, type MetricValue } from "../metrics/engine";
import { availableMetrics, metricMap } from "../metrics/packs";
import { activeGeneration } from "../sync/run";
import { withWorkspace } from "../db/pool";
import { listHealth } from "../health";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  ok: boolean;
  /** Every numeric value this result exposed, for grounding verification. */
  numbers: number[];
  data: unknown;
  error?: string;
}

export const TOOL_DEFINITIONS = [
  {
    name: "list_metrics",
    description:
      "List the metrics this workspace can answer right now, with their units and available breakdowns. Call this first when unsure which metric a question needs.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "query_metric",
    description:
      "Get the value of one or more approved metrics for a date range, optionally broken down by one dimension. This is the only way to obtain a number.",
    parameters: {
      type: "object",
      properties: {
        metricKeys: {
          type: "array",
          items: { type: "string" },
          description: "Metric keys exactly as returned by list_metrics.",
        },
        from: { type: "string", description: "Inclusive start date, YYYY-MM-DD." },
        to: { type: "string", description: "EXCLUSIVE end date, YYYY-MM-DD." },
        dimension: { type: "string", description: "Optional breakdown, e.g. user_id." },
      },
      required: ["metricKeys"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_metric",
    description:
      "Explain how a metric is calculated: its formula, which date it filters on, and its unit.",
    parameters: {
      type: "object",
      properties: { metricKey: { type: "string" } },
      required: ["metricKey"],
      additionalProperties: false,
    },
  },
  {
    name: "data_freshness",
    description:
      "When this workspace's data was last synced successfully, and whether the most recent attempt failed.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Metric keys this workspace can actually answer. */
async function availableKeys(context: WorkspaceContext): Promise<Set<string>> {
  const generationId = await activeGeneration(context);
  if (!generationId) return new Set();

  const populated = await withWorkspace(context, async (client) => {
    const found = new Set<string>();
    for (const table of [
      "fact_lead",
      "fact_order",
      "fact_order_line",
      "fact_invoice",
      "fact_payment",
    ]) {
      const { rows } = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = $1 AND generation_id = $2) AS present`,
        [context.workspaceId, generationId],
      );
      if (rows[0]?.present) found.add(table);
    }
    return found;
  });

  return new Set(availableMetrics(populated).map((metric) => metric.key));
}

/** Collects every number a result exposes, so grounding can check the answer. */
function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectNumbers(item, out);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, out);
  }
  return out;
}

/**
 * Executes a tool call.
 *
 * `context` is supplied by the server from the authenticated session. It is not
 * a tool parameter, so no prompt — however it is phrased, whatever it claims —
 * can redirect a call at another workspace.
 */
export async function runTool(context: WorkspaceContext, call: ToolCall): Promise<ToolResult> {
  const fail = (error: string): ToolResult => ({
    name: call.name,
    ok: false,
    numbers: [],
    data: null,
    error,
  });

  try {
    if (call.name === "list_metrics") {
      const available = await availableKeys(context);
      const definitions = metricMap();
      const data = [...available].map((key) => {
        const metric = definitions.get(key)!;
        return {
          key,
          label: metric.label,
          unit: metric.unit,
          dimensions: metric.allowedDimensions,
        };
      });
      // Metric metadata carries no measurements, so nothing here can be quoted
      // as a business number.
      return { name: call.name, ok: true, numbers: [], data };
    }

    if (call.name === "explain_metric") {
      const key = String(call.arguments.metricKey ?? "");
      const metric = metricMap().get(key);
      if (!metric) return fail(`Unknown metric "${key}".`);
      return {
        name: call.name,
        ok: true,
        numbers: [],
        data: {
          key,
          label: metric.label,
          formula: metric.formula,
          dateBasis: metric.dateColumn,
          unit: metric.unit,
          version: metric.version,
        },
      };
    }

    if (call.name === "data_freshness") {
      const health = await listHealth(context);
      return {
        name: call.name,
        ok: true,
        numbers: [],
        data: health.map((entry) => ({
          domain: entry.domain,
          status: entry.status,
          lastSuccessAt: entry.lastSuccessAt,
          lastAttemptAt: entry.lastAttemptAt,
        })),
      };
    }

    if (call.name === "query_metric") {
      const requested = Array.isArray(call.arguments.metricKeys)
        ? call.arguments.metricKeys.filter((k): k is string => typeof k === "string")
        : [];
      if (!requested.length) return fail("metricKeys is required.");

      const available = await availableKeys(context);
      const permitted = requested.filter((key) => available.has(key));
      const refused = requested.filter((key) => !available.has(key));

      // Refused rather than silently substituted: the model asked for something
      // specific, and quietly answering a different question is worse than
      // saying the data is not there.
      if (!permitted.length) {
        return fail(
          `None of those metrics can be answered for this workspace. Unavailable: ${refused.join(", ")}. Call list_metrics.`,
        );
      }

      const from = String(call.arguments.from ?? "");
      const to = String(call.arguments.to ?? "");
      const dimension =
        typeof call.arguments.dimension === "string" ? call.arguments.dimension : undefined;

      const values: MetricValue[] = await executeQuery(
        context,
        {
          metricKeys: permitted,
          dimensions: dimension ? [dimension] : undefined,
          // Half-open [from, to). An invalid range is dropped rather than
          // guessed, so the answer reports the full period instead of a
          // silently wrong one.
          dateRange: DATE.test(from) && DATE.test(to) ? { from, to } : undefined,
        },
        { definitions: metricMap(), generationId: await activeGeneration(context) },
      );

      return {
        name: call.name,
        ok: true,
        // Only the metric values are quotable. Versions and coverage ratios are
        // deliberately excluded so the model cannot present "1" (a version) as
        // a business figure.
        numbers: values
          .map((value) => value.value)
          .filter((value): value is number => value !== null),
        data: {
          values: values.map((value) => ({
            metricKey: value.metricKey,
            value: value.value,
            isAvailable: value.isAvailable,
            unavailableReason: value.unavailableReason,
            unit: value.unit,
            dimensions: value.dimensions,
            datePolicy: value.datePolicy,
            formula: value.formula,
          })),
          refused,
          dateRange: DATE.test(from) && DATE.test(to) ? { from, to } : null,
        },
      };
    }

    return fail(`Unknown tool "${call.name}".`);
  } catch (error) {
    const { safeErrorMessage } = await import("../audit/redact");
    return fail(safeErrorMessage(error, 200));
  }
}

/** Every number any tool returned, used to verify the final answer. */
export function groundedNumbers(results: ToolResult[]): number[] {
  return results.flatMap((result) => result.numbers).concat(collectNumbers([]));
}
