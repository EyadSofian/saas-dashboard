// Running a reconciliation against a generation.
//
// Asks Odoo for aggregates rather than records: `search_count` for a count and
// `read_group` for a sum. Both are computed server-side and return a few bytes,
// so verifying a million-row model costs one round trip rather than a second
// full extract.
import { withWorkspace } from "../db/pool";
import type { WorkspaceContext } from "../contracts";
import type { SafeOdooConnector } from "../odoo/connector";
import { OdooError } from "../odoo/connector";
import { safeErrorMessage } from "../audit/redact";
import type { ExtractionPlan } from "../sync/plan";
import {
  buildCheckSpecs,
  evaluate,
  QUALITY_RULES,
  verdictFor,
  type CheckResult,
  type QualityResult,
  type ReconciliationVerdict,
} from "./checks";

import type { CanonicalEntityKey } from "../semantic/concepts";

const CANONICAL_TABLES: Record<CanonicalEntityKey, string> = {
  lead: "fact_lead",
  order: "fact_order",
  orderLine: "fact_order_line",
  invoice: "fact_invoice",
  payment: "fact_payment",
  company: "dim_company",
  currency: "dim_currency",
  user: "dim_user",
  team: "dim_team",
  partner: "dim_partner",
  product: "dim_product",
  stage: "dim_stage",
};

/**
 * The domain the extract used, plus the same upper bound.
 *
 * Both halves matter. Without the domain we would compare all invoices against
 * only posted customer ones; without the bound we would count rows written
 * after the extract and call the difference an error.
 */
function comparisonDomain(plan: ExtractionPlan, upperBound: string | null): unknown[] {
  const domain = [...plan.domain];
  if (upperBound) domain.push(["write_date", "<=", upperBound]);
  return domain;
}

export interface RunReconciliationInput {
  generationId: string;
  plans: ExtractionPlan[];
  upperBound: string | null;
  connector: SafeOdooConnector;
}

export async function runReconciliation(
  context: WorkspaceContext,
  input: RunReconciliationInput,
): Promise<{
  runId: string;
  results: CheckResult[];
  quality: QualityResult[];
  verdict: ReconciliationVerdict;
}> {
  const runId = await withWorkspace(context, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO reconciliation_runs (workspace_id, generation_id, status)
       VALUES ($1,$2,'running') RETURNING id`,
      [context.workspaceId, input.generationId],
    );
    return rows[0].id;
  });

  const specs = buildCheckSpecs(input.plans);
  const plansByEntity = new Map<string, ExtractionPlan>(
    input.plans.map((plan) => [plan.entity as string, plan]),
  );
  const results: CheckResult[] = [];

  for (const spec of specs) {
    const plan = plansByEntity.get(spec.entity);
    const table = CANONICAL_TABLES[spec.entity as CanonicalEntityKey];
    if (!plan || !table) continue;

    const canonicalValue = await withWorkspace(context, async (client) => {
      const expression =
        spec.measure === "row_count" ? "count(*)::numeric" : `sum(${spec.canonicalColumn})`;
      const { rows } = await client.query<{ value: string | null }>(
        `SELECT ${expression} AS value FROM ${table}
          WHERE workspace_id = $1 AND generation_id = $2`,
        [context.workspaceId, input.generationId],
      );
      const raw = rows[0]?.value;
      return raw === null || raw === undefined ? null : Number(raw);
    });

    let sourceValue: number | null = null;
    let unavailable: string | undefined;

    try {
      const domain = comparisonDomain(plan, input.upperBound);
      if (spec.measure === "row_count") {
        sourceValue = await input.connector.call<number>(plan.odooModel, "search_count", [domain]);
      } else {
        // read_group with no groupby aggregates the whole domain: one row back
        // carrying the sum, computed by Odoo rather than by reading records.
        const groups = await input.connector.call<Array<Record<string, unknown>>>(
          plan.odooModel,
          "read_group",
          [domain, [spec.odooField!], []],
          { lazy: false },
        );
        const raw = groups[0]?.[spec.odooField!];
        sourceValue = raw === null || raw === undefined || raw === false ? 0 : Number(raw);
      }
    } catch (error) {
      unavailable =
        error instanceof OdooError && error.kind === "access"
          ? "access_denied"
          : safeErrorMessage(error, 120);
    }

    results.push(evaluate(spec, sourceValue, canonicalValue, unavailable));
  }

  const quality = await runQualityRules(context, input.generationId, input.plans);

  // A failing critical quality rule blocks publication just as a critical
  // reconciliation difference does: totals that match while every date is null
  // produce a dashboard that is correct in aggregate and empty in every view.
  const combined: CheckResult[] = [
    ...results,
    ...quality
      .filter((result) => !result.passed)
      .map((result) => ({
        key: result.ruleKey,
        entity: result.entity,
        measure: "row_count" as const,
        severity: result.severity,
        sourceValue: result.totalRows,
        canonicalValue: result.totalRows - result.failingRows,
        difference: -result.failingRows,
        tolerance: 0,
        passed: false,
      })),
  ];

  const verdict = verdictFor(combined);

  await withWorkspace(context, async (client) => {
    for (const result of results) {
      await client.query(
        `INSERT INTO reconciliation_checks
           (workspace_id, run_id, check_key, entity, measure, severity,
            source_value, canonical_value, difference, tolerance, passed, unavailable_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (workspace_id, run_id, check_key) DO NOTHING`,
        [
          context.workspaceId,
          runId,
          result.key,
          result.entity,
          result.measure,
          result.severity,
          result.sourceValue,
          result.canonicalValue,
          result.difference,
          result.tolerance,
          result.passed,
          result.unavailableReason ?? null,
        ],
      );
    }

    for (const result of quality) {
      await client.query(
        `INSERT INTO data_quality_results
           (workspace_id, run_id, rule_key, entity, severity, failing_rows, total_rows, passed, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (workspace_id, run_id, rule_key) DO NOTHING`,
        [
          context.workspaceId,
          runId,
          result.ruleKey,
          result.entity,
          result.severity,
          result.failingRows,
          result.totalRows,
          result.passed,
          result.detail,
        ],
      );
    }

    await client.query(
      "UPDATE reconciliation_runs SET status = $1, finished_at = now() WHERE id = $2 AND workspace_id = $3",
      [
        verdict.status === "passed" ? "passed" : verdict.status === "failed" ? "failed" : "running",
        runId,
        context.workspaceId,
      ],
    );
  });

  return { runId, results, quality, verdict };
}

async function runQualityRules(
  context: WorkspaceContext,
  generationId: string,
  plans: ExtractionPlan[],
): Promise<QualityResult[]> {
  const entities = new Set<string>(plans.map((plan) => plan.entity as string));
  const applicable = QUALITY_RULES.filter((rule) => entities.has(rule.entity));

  return withWorkspace(context, async (client) => {
    const results: QualityResult[] = [];

    for (const rule of applicable) {
      // Predicates are fixed strings defined in this repository, never derived
      // from customer or model input.
      const { rows } = await client.query<{ failing: string; total: string }>(
        `SELECT
           count(*) FILTER (WHERE ${rule.predicate})::text AS failing,
           count(*)::text AS total
         FROM ${rule.table}
        WHERE workspace_id = $1 AND generation_id = $2`,
        [context.workspaceId, generationId],
      );

      const failing = Number(rows[0]?.failing ?? 0);
      const total = Number(rows[0]?.total ?? 0);

      results.push({
        ruleKey: rule.key,
        entity: rule.entity,
        severity: rule.severity,
        failingRows: failing,
        totalRows: total,
        passed: failing === 0,
        detail: failing ? `${failing} of ${total} rows` : "",
      });
    }

    return results;
  });
}

/**
 * Records a human knowingly publishing past a non-critical difference.
 *
 * Only warnings can be accepted. A critical failure has no acceptance path at
 * all — there is no note a person can write that makes a mismatched revenue
 * total safe to put in front of an owner.
 */
export async function acceptWarnings(
  context: WorkspaceContext,
  runId: string,
  note: string,
): Promise<boolean> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reconciliation_checks
        WHERE workspace_id = $1 AND run_id = $2 AND NOT passed AND severity = 'critical'`,
      [context.workspaceId, runId],
    );
    if (Number(rows[0].count) > 0) return false;

    await client.query(
      `UPDATE reconciliation_runs
          SET status = 'accepted_with_warnings', accepted_by = $1, accepted_at = now(), accepted_note = $2
        WHERE workspace_id = $3 AND id = $4`,
      [context.userId, note.slice(0, 500), context.workspaceId, runId],
    );
    return true;
  });
}

export async function latestReconciliation(context: WorkspaceContext) {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT id, generation_id, status, accepted_note, accepted_at, started_at, finished_at
         FROM reconciliation_runs
        WHERE workspace_id = $1
        ORDER BY started_at DESC LIMIT 1`,
      [context.workspaceId],
    );
    const run = rows[0];
    if (!run) return null;

    const [checks, quality] = await Promise.all([
      client.query(
        `SELECT check_key, entity, measure, severity, source_value, canonical_value,
                difference, tolerance, passed, unavailable_reason
           FROM reconciliation_checks
          WHERE workspace_id = $1 AND run_id = $2
          ORDER BY passed, severity, check_key`,
        [context.workspaceId, run.id],
      ),
      client.query(
        `SELECT rule_key, entity, severity, failing_rows, total_rows, passed, detail
           FROM data_quality_results
          WHERE workspace_id = $1 AND run_id = $2
          ORDER BY passed, severity, rule_key`,
        [context.workspaceId, run.id],
      ),
    ]);

    return {
      id: String(run.id),
      generationId: String(run.generation_id),
      status: String(run.status),
      acceptedNote: run.accepted_note ? String(run.accepted_note) : null,
      acceptedAt: run.accepted_at ? new Date(String(run.accepted_at)).toISOString() : null,
      startedAt: new Date(String(run.started_at)).toISOString(),
      finishedAt: run.finished_at ? new Date(String(run.finished_at)).toISOString() : null,
      checks: checks.rows.map((row) => ({
        checkKey: String(row.check_key),
        entity: String(row.entity),
        measure: String(row.measure),
        severity: String(row.severity),
        sourceValue: row.source_value === null ? null : Number(row.source_value),
        canonicalValue: row.canonical_value === null ? null : Number(row.canonical_value),
        difference: row.difference === null ? null : Number(row.difference),
        tolerance: Number(row.tolerance),
        passed: Boolean(row.passed),
        unavailableReason: row.unavailable_reason ? String(row.unavailable_reason) : null,
      })),
      quality: quality.rows.map((row) => ({
        ruleKey: String(row.rule_key),
        entity: String(row.entity),
        severity: String(row.severity),
        failingRows: Number(row.failing_rows),
        totalRows: Number(row.total_rows),
        passed: Boolean(row.passed),
        detail: String(row.detail),
      })),
    };
  });
}
