// Contracts for the semantic mapping proposal.
//
// Every field a proposer emits is validated against these schemas before it is
// stored, and every path it names is then checked against the frozen snapshot.
// A proposer cannot invent an Odoo field, whatever it writes.
import { z } from "zod";

export const evidenceSchema = z
  .object({
    kind: z.enum(["field_name", "field_label", "help_text", "field_type", "relation", "hint"]),
    /** What was observed, verbatim — customer-controlled text, held as data. */
    detail: z.string().max(500),
    odooModel: z.string().max(128).optional(),
    odooField: z.string().max(128).optional(),
  })
  .strict();

export type Evidence = z.infer<typeof evidenceSchema>;

export const mappingAlternativeSchema = z
  .object({
    odooModel: z.string().max(128),
    odooField: z.string().max(128),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(300),
  })
  .strict();

export const fieldMappingProposalSchema = z
  .object({
    canonicalField: z.string().min(1).max(128),
    odooModel: z.string().max(128).nullable(),
    odooField: z.string().max(128).nullable(),
    /** Relation hops from the entity's own model, e.g. ["stage_id"]. */
    relationPath: z.array(z.string().max(128)).max(4).default([]),
    /**
     * A ranking signal, NOT a calibrated probability. A model writing 0.95 does
     * not mean 95% correct, and the UI must never present it as one.
     */
    confidence: z.number().min(0).max(1),
    evidence: z.array(evidenceSchema).max(8).default([]),
    alternatives: z.array(mappingAlternativeSchema).max(4).default([]),
    riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
    explanation: z.object({ ar: z.string().max(600), en: z.string().max(600) }).strict(),
  })
  .strict();

export type FieldMappingProposal = z.infer<typeof fieldMappingProposalSchema>;

export const entityMappingProposalSchema = z
  .object({
    canonicalEntity: z.string().min(1).max(64),
    odooModel: z.string().max(128).nullable(),
    primaryKey: z.string().max(128).default("id"),
    confidence: z.number().min(0).max(1),
    evidence: z.array(evidenceSchema).max(8).default([]),
  })
  .strict();

export type EntityMappingProposal = z.infer<typeof entityMappingProposalSchema>;

export const mappingProposalSchema = z
  .object({
    schemaSnapshotId: z.string().uuid(),
    entities: z.array(entityMappingProposalSchema).max(32),
    fields: z.array(fieldMappingProposalSchema).max(256),
    /** Concepts the proposer could not find at all — stated, never guessed. */
    unmapped: z.array(z.string().max(128)).max(256).default([]),
  })
  .strict();

export type MappingProposal = z.infer<typeof mappingProposalSchema>;

/**
 * The shape the AI model is asked to return.
 *
 * Kept flatter and smaller than the internal contract on purpose: every extra
 * nested field is another thing a model can get subtly wrong, and everything
 * omitted here is derived deterministically afterwards.
 */
export const aiProposalSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            canonicalField: z.string(),
            odooModel: z.string().nullable(),
            odooField: z.string().nullable(),
            confidence: z.number().min(0).max(1),
            reasoning: z.string().max(400),
            explanationAr: z.string().max(400),
            explanationEn: z.string().max(400),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

export type AiProposal = z.infer<typeof aiProposalSchema>;

/** Below this, a proposal is presented as unresolved rather than as a default. */
export const CONFIDENCE_PRESENT_THRESHOLD = 0.7;

export const MAPPING_STATUSES = ["needs_review", "approved", "rejected", "unavailable"] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

export const mappingDecisionSchema = z
  .object({
    canonicalField: z.string().min(1).max(128),
    status: z.enum(MAPPING_STATUSES),
    /** Set when a reviewer overrides the proposal with a different path. */
    odooModel: z.string().max(128).nullable().optional(),
    odooField: z.string().max(128).nullable().optional(),
    relationPath: z.array(z.string().max(128)).max(4).optional(),
  })
  .strict();

export type MappingDecision = z.infer<typeof mappingDecisionSchema>;

export const policyDecisionSchema = z
  .object({ policyKey: z.string().min(1).max(64), value: z.string().min(1).max(64) })
  .strict();
