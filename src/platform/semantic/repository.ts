// Persistence for the semantic layer.
//
// A manifest is immutable once published. Re-proposing creates a new draft
// version rather than editing an approved one, so an approval always refers to
// a specific, unchanging set of mappings.
import { withWorkspace } from "../db/pool";
import { requirePermission } from "../workspace/repository";
import type { WorkspaceContext } from "../contracts";
import { contentHash } from "../contracts";
import { alwaysRequiresApproval, CONCEPTS_BY_KEY, REPORTING_POLICIES } from "./concepts";
import {
  CONFIDENCE_PRESENT_THRESHOLD,
  type MappingDecision,
  type MappingProposal,
} from "./contracts";
import type { AiRunRecord } from "./ai-proposer";

export interface StoredMapping {
  canonicalField: string;
  odooModel: string | null;
  odooField: string | null;
  relationPath: string[];
  confidence: number | null;
  evidence: unknown[];
  alternatives: unknown[];
  riskLevel: string;
  requiresHumanApproval: boolean;
  status: string;
  explanationAr: string;
  explanationEn: string;
}

export interface ManifestSummary {
  id: string;
  version: number;
  status: string;
  snapshotId: string;
  contentHash: string | null;
  createdAt: string;
  publishedAt: string | null;
  counts: { total: number; approved: number; needsReview: number; unavailable: number };
}

/**
 * Stores a proposal as a new draft manifest version.
 *
 * Every mapping starts at `needs_review`. Nothing is auto-approved in V1, not
 * even a confidence of 1 — the deterministic proposer is confident about
 * `create_date`, but it is the customer's business that gets misreported if the
 * product is wrong, so the customer decides.
 */
export async function createManifestFromProposal(
  context: WorkspaceContext,
  input: { snapshotId: string; proposal: MappingProposal; aiRun?: AiRunRecord | null },
): Promise<ManifestSummary> {
  requirePermission(context, "discovery.run");

  return withWorkspace(context, async (client) => {
    const { rows: versionRows } = await client.query<{ next: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM semantic_manifests WHERE workspace_id = $1",
      [context.workspaceId],
    );
    const version = Number(versionRows[0].next);

    const hash = contentHash({
      entities: input.proposal.entities,
      fields: input.proposal.fields.map((f) => ({
        k: f.canonicalField,
        m: f.odooModel,
        f: f.odooField,
        p: f.relationPath,
      })),
    });

    const { rows } = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO semantic_manifests (workspace_id, snapshot_id, version, status, content_hash)
       VALUES ($1, $2, $3, 'in_review', $4)
       RETURNING id, created_at`,
      [context.workspaceId, input.snapshotId, version, hash],
    );
    const manifestId = rows[0].id;

    for (const entity of input.proposal.entities) {
      await client.query(
        `INSERT INTO semantic_entity_mappings
           (workspace_id, manifest_id, canonical_entity, odoo_model, primary_key, confidence, evidence, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          context.workspaceId,
          manifestId,
          entity.canonicalEntity,
          entity.odooModel ?? "",
          entity.primaryKey,
          entity.confidence,
          JSON.stringify(entity.evidence),
          entity.odooModel ? "needs_review" : "unavailable",
        ],
      );
    }

    for (const mapping of input.proposal.fields) {
      const concept = CONCEPTS_BY_KEY.get(mapping.canonicalField);
      await client.query(
        `INSERT INTO semantic_field_mappings
           (workspace_id, manifest_id, canonical_field, odoo_model, odoo_field, relation_path,
            confidence, evidence, alternatives, risk_level, requires_human_approval, status,
            explanation_ar, explanation_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)`,
        [
          context.workspaceId,
          manifestId,
          mapping.canonicalField,
          mapping.odooModel,
          mapping.odooField,
          mapping.relationPath,
          mapping.confidence,
          JSON.stringify(mapping.evidence),
          JSON.stringify(mapping.alternatives),
          concept?.riskLevel ?? mapping.riskLevel,
          // High-risk concepts always need a human, whatever the confidence.
          true,
          mapping.odooField ? "needs_review" : "unavailable",
          mapping.explanation.ar,
          mapping.explanation.en,
        ],
      );
    }

    // Seed the policy questions. These are business decisions no amount of
    // metadata inspection can answer, so they are asked explicitly.
    for (const policy of REPORTING_POLICIES) {
      await client.query(
        `INSERT INTO reporting_policies
           (workspace_id, manifest_id, policy_key, value, options, status, question_ar, question_en)
         VALUES ($1,$2,$3,$4,$5::jsonb,'needs_review',$6,$7)`,
        [
          context.workspaceId,
          manifestId,
          policy.key,
          policy.defaultValue,
          JSON.stringify(policy.options),
          policy.question.ar,
          policy.question.en,
        ],
      );
    }

    if (input.aiRun) {
      await client.query(
        `INSERT INTO ai_runs
           (workspace_id, purpose, provider, model, prompt_version, input_hash, output_hash,
            input_tokens, output_tokens, latency_ms, schema_retries, status, error)
         VALUES ($1,'semantic_mapping',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          context.workspaceId,
          input.aiRun.provider,
          input.aiRun.model,
          input.aiRun.promptVersion,
          input.aiRun.inputHash,
          input.aiRun.outputHash,
          input.aiRun.inputTokens,
          input.aiRun.outputTokens,
          input.aiRun.latencyMs,
          input.aiRun.schemaRetries,
          input.aiRun.status,
          input.aiRun.error ?? null,
        ],
      );
    }

    // Supersede earlier drafts so exactly one manifest is under review.
    await client.query(
      `UPDATE semantic_manifests SET status = 'superseded'
        WHERE workspace_id = $1 AND id <> $2 AND status IN ('draft','in_review')`,
      [context.workspaceId, manifestId],
    );

    return {
      id: manifestId,
      version,
      status: "in_review",
      snapshotId: input.snapshotId,
      contentHash: hash,
      createdAt: new Date(rows[0].created_at).toISOString(),
      publishedAt: null,
      counts: {
        total: input.proposal.fields.length,
        approved: 0,
        needsReview: input.proposal.fields.filter((f) => f.odooField).length,
        unavailable: input.proposal.fields.filter((f) => !f.odooField).length,
      },
    };
  });
}

export async function currentManifest(context: WorkspaceContext): Promise<ManifestSummary | null> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT m.*,
              count(f.*) FILTER (WHERE true)                              AS total,
              count(f.*) FILTER (WHERE f.status = 'approved')             AS approved,
              count(f.*) FILTER (WHERE f.status = 'needs_review')         AS needs_review,
              count(f.*) FILTER (WHERE f.status = 'unavailable')          AS unavailable
         FROM semantic_manifests m
         LEFT JOIN semantic_field_mappings f
                ON f.manifest_id = m.id AND f.workspace_id = m.workspace_id
        WHERE m.workspace_id = $1 AND m.status IN ('in_review','approved','published')
        GROUP BY m.id
        ORDER BY m.version DESC
        LIMIT 1`,
      [context.workspaceId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      version: Number(row.version),
      status: String(row.status),
      snapshotId: String(row.snapshot_id),
      contentHash: row.content_hash ? String(row.content_hash) : null,
      createdAt: new Date(String(row.created_at)).toISOString(),
      publishedAt: row.published_at ? new Date(String(row.published_at)).toISOString() : null,
      counts: {
        total: Number(row.total),
        approved: Number(row.approved),
        needsReview: Number(row.needs_review),
        unavailable: Number(row.unavailable),
      },
    };
  });
}

export async function listMappings(
  context: WorkspaceContext,
  manifestId: string,
): Promise<StoredMapping[]> {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT canonical_field, odoo_model, odoo_field, relation_path, confidence,
              evidence, alternatives, risk_level, requires_human_approval, status,
              explanation_ar, explanation_en
         FROM semantic_field_mappings
        WHERE workspace_id = $1 AND manifest_id = $2
        ORDER BY
          -- Money and lifecycle first: those are the decisions that matter.
          CASE risk_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          CASE status WHEN 'needs_review' THEN 0 WHEN 'unavailable' THEN 1 ELSE 2 END,
          canonical_field`,
      [context.workspaceId, manifestId],
    );
    return rows.map((row) => ({
      canonicalField: String(row.canonical_field),
      odooModel: row.odoo_model ? String(row.odoo_model) : null,
      odooField: row.odoo_field ? String(row.odoo_field) : null,
      relationPath: (row.relation_path as string[]) ?? [],
      confidence: row.confidence === null ? null : Number(row.confidence),
      evidence: (row.evidence as unknown[]) ?? [],
      alternatives: (row.alternatives as unknown[]) ?? [],
      riskLevel: String(row.risk_level),
      requiresHumanApproval: Boolean(row.requires_human_approval),
      status: String(row.status),
      explanationAr: String(row.explanation_ar),
      explanationEn: String(row.explanation_en),
    }));
  });
}

export async function listPolicies(context: WorkspaceContext, manifestId: string) {
  return withWorkspace(context, async (client) => {
    const { rows } = await client.query(
      `SELECT policy_key, value, options, status, question_ar, question_en
         FROM reporting_policies
        WHERE workspace_id = $1 AND manifest_id = $2
        ORDER BY policy_key`,
      [context.workspaceId, manifestId],
    );
    return rows.map((row) => ({
      policyKey: String(row.policy_key),
      value: String(row.value),
      options: row.options as Array<{ value: string; label: { ar: string; en: string } }>,
      status: String(row.status),
      question: { ar: String(row.question_ar), en: String(row.question_en) },
    }));
  });
}

/** Records a reviewer's decision on one mapping. */
export async function decideMapping(
  context: WorkspaceContext,
  manifestId: string,
  decision: MappingDecision,
): Promise<void> {
  requirePermission(context, "policy.approve");

  await withWorkspace(context, async (client) => {
    await client.query(
      `UPDATE semantic_field_mappings
          SET status = $1,
              odoo_model = COALESCE($2, odoo_model),
              odoo_field = COALESCE($3, odoo_field),
              relation_path = COALESCE($4, relation_path),
              approved_by = CASE WHEN $1 = 'approved' THEN $5::uuid ELSE NULL END,
              approved_at = CASE WHEN $1 = 'approved' THEN now() ELSE NULL END
        WHERE workspace_id = $6 AND manifest_id = $7 AND canonical_field = $8`,
      [
        decision.status,
        decision.odooModel ?? null,
        decision.odooField ?? null,
        decision.relationPath ?? null,
        context.userId,
        context.workspaceId,
        manifestId,
        decision.canonicalField,
      ],
    );
  });
}

export async function decidePolicy(
  context: WorkspaceContext,
  manifestId: string,
  policyKey: string,
  value: string,
): Promise<void> {
  requirePermission(context, "policy.approve");

  await withWorkspace(context, async (client) => {
    await client.query(
      `UPDATE reporting_policies
          SET value = $1, status = 'approved', approved_by = $2, approved_at = now()
        WHERE workspace_id = $3 AND manifest_id = $4 AND policy_key = $5`,
      [value, context.userId, context.workspaceId, manifestId, policyKey],
    );
  });
}

export interface PublishBlocker {
  kind: "mapping" | "policy";
  key: string;
  reason: string;
}

/**
 * What still stands between this manifest and publication.
 *
 * Publication is blocked — not warned about — while any high-risk concept is
 * unapproved. A dashboard built on an unapproved revenue definition is worse
 * than no dashboard, because it looks authoritative.
 */
export async function publishBlockers(
  context: WorkspaceContext,
  manifestId: string,
): Promise<PublishBlocker[]> {
  const [mappings, policies] = await Promise.all([
    listMappings(context, manifestId),
    listPolicies(context, manifestId),
  ]);

  const blockers: PublishBlocker[] = [];

  for (const mapping of mappings) {
    if (mapping.status === "approved" || mapping.status === "rejected") continue;
    if (mapping.status === "unavailable") {
      const concept = CONCEPTS_BY_KEY.get(mapping.canonicalField);
      // A missing optional concept is fine; a missing required one is not.
      if (concept?.required) {
        blockers.push({
          kind: "mapping",
          key: mapping.canonicalField,
          reason: "required_concept_unavailable",
        });
      }
      continue;
    }
    if (alwaysRequiresApproval(mapping.canonicalField)) {
      blockers.push({
        kind: "mapping",
        key: mapping.canonicalField,
        reason: "financial_mapping_needs_approval",
      });
    }
  }

  for (const policy of policies) {
    if (policy.status !== "approved") {
      blockers.push({ kind: "policy", key: policy.policyKey, reason: "policy_needs_approval" });
    }
  }

  return blockers;
}

export async function publishManifest(
  context: WorkspaceContext,
  manifestId: string,
): Promise<{ published: boolean; blockers: PublishBlocker[] }> {
  requirePermission(context, "policy.approve");

  const blockers = await publishBlockers(context, manifestId);
  if (blockers.length) return { published: false, blockers };

  await withWorkspace(context, async (client) => {
    await client.query(
      `UPDATE semantic_manifests
          SET status = 'published', published_at = now(), published_by = $1
        WHERE workspace_id = $2 AND id = $3`,
      [context.userId, context.workspaceId, manifestId],
    );
    await client.query("UPDATE workspaces SET onboarding_state = 'published' WHERE id = $1", [
      context.workspaceId,
    ]);
  });

  return { published: true, blockers: [] };
}

/** Confidence below this is shown as unresolved rather than as a suggestion. */
export const PRESENT_THRESHOLD = CONFIDENCE_PRESENT_THRESHOLD;
