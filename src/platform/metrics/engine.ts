// Metric engine: typed definitions compiled to parameterized SQL.
//
// No LLM writes SQL here, and no SQL fragment is ever accepted from a caller.
// A metric is data — an aggregation, a filter list, a date field — and this
// module is the only thing that turns that data into a query.
//
// The rules it exists to enforce:
//   • a ratio with a zero denominator is null, never 0, NaN or Infinity
//   • percentages are recomputed from totals, never averaged
//   • an undated row is excluded when a date filter is active
//   • a metric declares its grain, and a join that would multiply it is refused
//   • every read pins exactly one generation
import { withWorkspace } from "../db/pool";
import type { WorkspaceContext } from "../contracts";

export type MetricUnit = "count" | "currency" | "percent" | "duration" | "number";
export type FanoutPolicy = "forbid" | "aggregate_before_join" | "distinct_entity";

/** Closed operator set. An unknown operator rejects the whole definition. */
export const AGGREGATIONS = [
  "count",
  "count_distinct",
  "sum",
  "avg",
  "min",
  "max",
  "ratio",
] as const;
export type AggregationOp = (typeof AGGREGATIONS)[number];

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_true",
  "is_false",
  "is_null",
  "is_not_null",
] as const;
export type FilterOp = (typeof FILTER_OPERATORS)[number];

export interface MetricFilter {
  column: string;
  op: FilterOp;
  value?: string | number | boolean | Array<string | number>;
}

export interface MetricDefinition {
  key: string;
  label: { ar: string; en: string };
  /** The canonical table this metric reads. */
  table: string;
  /** One row of `table` is one of these. Used to refuse fan-out. */
  grain: "document" | "line" | "dimension";
  aggregation: AggregationOp;
  /** Column to aggregate. Omitted for `count`. */
  column?: string;
  filters: MetricFilter[];
  /** Column the date range applies to. Null means the metric is not dateable. */
  dateColumn: string | null;
  unit: MetricUnit;
  fanoutPolicy: FanoutPolicy;
  allowedDimensions: string[];
  /** For ratio metrics: the two metric keys to divide. */
  numeratorKey?: string;
  denominatorKey?: string;
  /** Plain-language explainability, shown in the "how is this calculated" drawer. */
  formula: { ar: string; en: string };
  version: number;
}

export class MetricDefinitionError extends Error {
  constructor(
    message: string,
    readonly metricKey: string,
  ) {
    super(message);
    this.name = "MetricDefinitionError";
  }
}

/** Identifiers are interpolated into SQL, so they come from a closed allowlist. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const ALLOWED_TABLES = new Set([
  "fact_lead",
  "fact_order",
  "fact_order_line",
  "fact_invoice",
  "fact_payment",
  "dim_company",
  "dim_currency",
  "dim_user",
  "dim_team",
  "dim_partner",
  "dim_product",
  "dim_stage",
]);

export function validateDefinition(definition: MetricDefinition): void {
  const fail = (message: string) => {
    throw new MetricDefinitionError(message, definition.key);
  };

  if (!ALLOWED_TABLES.has(definition.table)) fail(`Unknown table "${definition.table}".`);
  if (!AGGREGATIONS.includes(definition.aggregation)) {
    fail(`Unknown aggregation "${definition.aggregation}".`);
  }

  if (definition.aggregation === "ratio") {
    if (!definition.numeratorKey || !definition.denominatorKey) {
      fail("A ratio metric needs both a numerator and a denominator.");
    }
  } else if (definition.aggregation !== "count") {
    if (!definition.column) fail(`Aggregation "${definition.aggregation}" needs a column.`);
    if (!IDENTIFIER.test(definition.column!)) fail(`Invalid column "${definition.column}".`);
  }

  if (definition.dateColumn && !IDENTIFIER.test(definition.dateColumn)) {
    fail(`Invalid date column "${definition.dateColumn}".`);
  }

  for (const filter of definition.filters) {
    if (!IDENTIFIER.test(filter.column)) fail(`Invalid filter column "${filter.column}".`);
    if (!FILTER_OPERATORS.includes(filter.op)) fail(`Unknown filter operator "${filter.op}".`);
  }

  for (const dimension of definition.allowedDimensions) {
    if (!IDENTIFIER.test(dimension)) fail(`Invalid dimension "${dimension}".`);
  }

  // A line-grain metric summed against a document-grain question multiplies the
  // document total by its line count. Refusing at definition time is the only
  // place this is catchable before it becomes a wrong number on a screen.
  if (definition.grain === "line" && definition.fanoutPolicy === "forbid") {
    if (definition.aggregation === "count") {
      fail(
        "A line-grain count with fanoutPolicy 'forbid' would count lines while " +
          "reading as documents. Use count_distinct on the parent id, or declare " +
          "fanoutPolicy 'distinct_entity'.",
      );
    }
  }
}

export interface MetricQuery {
  metricKeys: string[];
  dimensions?: string[];
  dateRange?: { from: string; to: string };
  filters?: MetricFilter[];
}

export interface MetricValue {
  metricKey: string;
  /** null means unavailable. Never a fabricated zero. */
  value: number | null;
  isAvailable: boolean;
  unavailableReason?: string;
  unit: MetricUnit;
  coverage: { ratio: number; warnings: string[] };
  dimensions?: Record<string, string | null>;
  datePolicy: string | null;
  metricVersion: number;
  generationId: string | null;
  formula: { ar: string; en: string };
}

interface Compiled {
  sql: string;
  params: unknown[];
}

function pushParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function compileFilter(filter: MetricFilter, params: unknown[]): string {
  const column = filter.column;
  switch (filter.op) {
    case "is_true":
      return `${column} IS TRUE`;
    case "is_false":
      return `${column} IS FALSE`;
    case "is_null":
      return `${column} IS NULL`;
    case "is_not_null":
      return `${column} IS NOT NULL`;
    case "in":
    case "not_in": {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      if (!values.length) return filter.op === "in" ? "FALSE" : "TRUE";
      const placeholders = values.map((value) => pushParam(params, value)).join(",");
      return `${column} ${filter.op === "in" ? "IN" : "NOT IN"} (${placeholders})`;
    }
    default: {
      const operators: Record<string, string> = {
        eq: "=",
        neq: "<>",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      };
      return `${column} ${operators[filter.op]} ${pushParam(params, filter.value)}`;
    }
  }
}

/**
 * Compiles one metric into a parameterized query.
 *
 * Date ranges are half-open `[from, to)`: an inclusive end date silently drops
 * or double-counts the boundary day depending on whether the column is a date
 * or a timestamp, and half-open is the only form that behaves identically for
 * both.
 */
export function compileMetric(
  definition: MetricDefinition,
  query: MetricQuery,
  generationId: string,
  workspaceId: string,
): Compiled {
  validateDefinition(definition);

  const params: unknown[] = [];
  const conditions: string[] = [
    `workspace_id = ${pushParam(params, workspaceId)}`,
    `generation_id = ${pushParam(params, generationId)}`,
  ];

  for (const filter of definition.filters) conditions.push(compileFilter(filter, params));
  for (const filter of query.filters ?? []) {
    if (!IDENTIFIER.test(filter.column)) continue; // Silently ignore, never interpolate.
    conditions.push(compileFilter(filter, params));
  }

  if (query.dateRange && definition.dateColumn) {
    conditions.push(`${definition.dateColumn} >= ${pushParam(params, query.dateRange.from)}`);
    conditions.push(`${definition.dateColumn} < ${pushParam(params, query.dateRange.to)}`);
    // An undated row cannot belong to a period. Including it would inflate
    // "this month" with rows that have no month at all.
    conditions.push(`${definition.dateColumn} IS NOT NULL`);
  }

  const dimensions = (query.dimensions ?? []).filter(
    (dimension) => IDENTIFIER.test(dimension) && definition.allowedDimensions.includes(dimension),
  );

  let expression: string;
  switch (definition.aggregation) {
    case "count":
      expression = "count(*)::numeric";
      break;
    case "count_distinct":
      expression = `count(DISTINCT ${definition.column})::numeric`;
      break;
    case "sum":
      // sum() of an all-null set is NULL in PostgreSQL, which is exactly the
      // semantics we want: nothing reported is not the same as zero.
      expression = `sum(${definition.column})`;
      break;
    case "avg":
      expression = `avg(${definition.column})`;
      break;
    case "min":
      expression = `min(${definition.column})`;
      break;
    case "max":
      expression = `max(${definition.column})`;
      break;
    default:
      throw new MetricDefinitionError("Ratio metrics are composed, not compiled.", definition.key);
  }

  const select = [
    ...dimensions.map((dimension) => `${dimension}::text AS dim_${dimension}`),
    `${expression} AS value`,
    "count(*)::numeric AS row_count",
  ].join(", ");

  const sql = [
    `SELECT ${select}`,
    `FROM ${definition.table}`,
    `WHERE ${conditions.join(" AND ")}`,
    dimensions.length ? `GROUP BY ${dimensions.join(", ")}` : "",
    dimensions.length ? `ORDER BY value DESC NULLS LAST` : "",
    dimensions.length ? "LIMIT 100" : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { sql, params };
}

/**
 * Divides two metric values.
 *
 * Returns null for a zero, negative or missing denominator. This is the single
 * most important line in the engine: a ratio that renders as 0 because nothing
 * was spent reads as a real result and gets acted on.
 */
export function safeRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (denominator <= 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

export interface ExecuteOptions {
  definitions: Map<string, MetricDefinition>;
  generationId: string | null;
}

export async function executeQuery(
  context: WorkspaceContext,
  query: MetricQuery,
  options: ExecuteOptions,
): Promise<MetricValue[]> {
  const results: MetricValue[] = [];

  const unavailable = (key: string, reason: string): MetricValue => {
    const definition = options.definitions.get(key);
    return {
      metricKey: key,
      value: null,
      isAvailable: false,
      unavailableReason: reason,
      unit: definition?.unit ?? "number",
      coverage: { ratio: 0, warnings: [reason] },
      datePolicy: definition?.dateColumn ?? null,
      metricVersion: definition?.version ?? 0,
      generationId: options.generationId,
      formula: definition?.formula ?? { ar: "", en: "" },
    };
  };

  // Nothing published yet is a legitimate state, not an error: the answer is
  // "not available", and it says why.
  if (!options.generationId) {
    return query.metricKeys.map((key) => unavailable(key, "no_published_data"));
  }

  for (const key of query.metricKeys) {
    const definition = options.definitions.get(key);
    if (!definition) {
      results.push(unavailable(key, "unknown_metric"));
      continue;
    }

    if (definition.aggregation === "ratio") {
      const [numerator, denominator] = await Promise.all([
        executeQuery(context, { ...query, metricKeys: [definition.numeratorKey!] }, options),
        executeQuery(context, { ...query, metricKeys: [definition.denominatorKey!] }, options),
      ]);
      const value = safeRatio(numerator[0]?.value ?? null, denominator[0]?.value ?? null);
      results.push({
        metricKey: key,
        value: value === null ? null : definition.unit === "percent" ? value * 100 : value,
        isAvailable: value !== null,
        unavailableReason: value === null ? "zero_or_missing_denominator" : undefined,
        unit: definition.unit,
        coverage: {
          ratio: value === null ? 0 : 1,
          warnings: value === null ? ["denominator_is_zero_or_missing"] : [],
        },
        datePolicy: definition.dateColumn,
        metricVersion: definition.version,
        generationId: options.generationId,
        formula: definition.formula,
      });
      continue;
    }

    let compiled: Compiled;
    try {
      compiled = compileMetric(definition, query, options.generationId, context.workspaceId);
    } catch (error) {
      results.push(
        unavailable(
          key,
          error instanceof MetricDefinitionError ? "invalid_definition" : "compile_failed",
        ),
      );
      continue;
    }

    const rows = await withWorkspace(context, async (client) => {
      const result = await client.query(compiled.sql, compiled.params);
      return result.rows;
    });

    if (!rows.length) {
      // No rows matched. For a count that genuinely is zero; for a sum it is
      // "nothing reported", which is not the same thing.
      results.push({
        metricKey: key,
        value: definition.aggregation === "count" ? 0 : null,
        isAvailable: definition.aggregation === "count",
        unavailableReason: definition.aggregation === "count" ? undefined : "no_matching_rows",
        unit: definition.unit,
        coverage: { ratio: 1, warnings: [] },
        datePolicy: definition.dateColumn,
        metricVersion: definition.version,
        generationId: options.generationId,
        formula: definition.formula,
      });
      continue;
    }

    for (const row of rows) {
      const raw = row.value;
      const value = raw === null || raw === undefined ? null : Number(raw);
      const dimensions = Object.fromEntries(
        Object.entries(row)
          .filter(([column]) => column.startsWith("dim_"))
          .map(([column, dimensionValue]) => [
            column.slice(4),
            dimensionValue === null ? null : String(dimensionValue),
          ]),
      );

      results.push({
        metricKey: key,
        value,
        isAvailable: value !== null,
        unavailableReason: value === null ? "no_values_reported" : undefined,
        unit: definition.unit,
        coverage: { ratio: 1, warnings: [] },
        dimensions: Object.keys(dimensions).length ? dimensions : undefined,
        datePolicy: definition.dateColumn,
        metricVersion: definition.version,
        generationId: options.generationId,
        formula: definition.formula,
      });
    }
  }

  return results;
}
