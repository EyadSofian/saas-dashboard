// Mapping proposers.
//
// Two implementations behind one interface:
//
//   DeterministicProposer  scores candidate fields by name, type, relation and
//                          label. Always available, free, reproducible, and the
//                          baseline every AI proposal is measured against.
//
//   AiProposer             asks a model to resolve what the rules could not.
//                          Never runs alone — it refines the deterministic
//                          result and its output is validated against the
//                          snapshot before anything is stored.
//
// The deterministic pass exists because most mappings are genuinely
// unambiguous: `crm.lead.create_date` is the lead creation date in every Odoo
// ever shipped. Spending a model call on that is waste, and a model is more
// likely to get it wrong than a rule is.
import type { SchemaField, SnapshotPayload } from "../contracts";
import {
  CANONICAL_CONCEPTS,
  CANONICAL_ENTITY_LIST,
  type CanonicalConcept,
  type CanonicalEntityKey,
} from "./concepts";
import type {
  EntityMappingProposal,
  Evidence,
  FieldMappingProposal,
  MappingProposal,
} from "./contracts";

export interface ProposerContext {
  snapshotId: string;
  payload: SnapshotPayload;
}

export interface MappingProposer {
  readonly id: string;
  propose(context: ProposerContext): Promise<MappingProposal>;
}

/* ------------------------------------------------------------------ entity -- */

/**
 * Picks the Odoo model for each canonical entity.
 *
 * Exact hint matches win outright — `crm.lead` is the lead model, and no amount
 * of cleverness improves on that. Everything else stays unmapped rather than
 * being guessed.
 */
export function proposeEntities(payload: SnapshotPayload): EntityMappingProposal[] {
  const accessible = new Set(payload.models.filter((m) => m.accessible).map((m) => m.model));

  return CANONICAL_ENTITY_LIST.map((entity) => {
    const hit = entity.hints.find((hint) => accessible.has(hint));
    return {
      canonicalEntity: entity.key,
      odooModel: hit ?? null,
      primaryKey: "id",
      confidence: hit ? 1 : 0,
      evidence: hit
        ? [
            {
              kind: "hint" as const,
              detail: `Standard Odoo model for ${entity.key}`,
              odooModel: hit,
            },
          ]
        : [],
    };
  });
}

export function entityModelMap(entities: EntityMappingProposal[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entity of entities) {
    if (entity.odooModel) map.set(entity.canonicalEntity, entity.odooModel);
  }
  return map;
}

/* ------------------------------------------------------------- field score -- */

const TYPE_AFFINITY: Record<string, string[]> = {
  id: ["integer"],
  text: ["char", "text"],
  number: ["integer", "float"],
  money: ["monetary"],
  date: ["date"],
  datetime: ["datetime"],
  boolean: ["boolean"],
  reference: ["many2one"],
  selection: ["selection"],
};

interface Scored {
  field: SchemaField;
  score: number;
  evidence: Evidence[];
}

/**
 * Scores one candidate field against one concept.
 *
 * The weights are deliberately blunt: an exact hint match is decisive, type
 * compatibility is a gate, and label similarity only ever breaks ties. A
 * cleverer scorer would be harder to explain to a customer reviewing why a
 * mapping was proposed — and explainability is the point.
 */
function scoreCandidate(concept: CanonicalConcept, field: SchemaField): Scored | null {
  const affinity = TYPE_AFFINITY[concept.type] ?? [];
  const typeMatches = affinity.includes(field.type);

  // A reference concept must be a relation; a money concept must be numeric.
  // Without this gate, name similarity alone would map "amount_total" onto a
  // char field called "amount_note".
  if (concept.type === "reference" && field.type !== "many2one") return null;
  if (concept.type === "money" && !["monetary", "float"].includes(field.type)) return null;
  if (concept.type === "date" && !["date", "datetime"].includes(field.type)) return null;
  if (concept.type === "datetime" && !["date", "datetime"].includes(field.type)) return null;

  let score = 0;
  const evidence: Evidence[] = [];

  if (concept.hints?.includes(field.name)) {
    score += 0.7;
    evidence.push({
      kind: "field_name",
      detail: `Field name "${field.name}" is the standard Odoo field for this concept.`,
      odooModel: field.model,
      odooField: field.name,
    });
  }

  if (typeMatches) {
    score += 0.15;
    evidence.push({
      kind: "field_type",
      detail: `Type "${field.type}" matches the expected ${concept.type}.`,
      odooModel: field.model,
      odooField: field.name,
    });
  }

  // Label similarity, computed on the English concept label only. Customer
  // labels are untrusted text: they are used as a weak signal and quoted back
  // as evidence, never interpreted.
  const label = field.label.toLowerCase();
  const conceptWords = concept.label.en
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const overlap = conceptWords.filter((word) => label.includes(word)).length;
  if (overlap > 0 && conceptWords.length > 0) {
    score += Math.min(0.15, 0.08 * overlap);
    evidence.push({
      kind: "field_label",
      detail: `Label "${field.label}" overlaps the concept name.`,
      odooModel: field.model,
      odooField: field.name,
    });
  }

  // A stored field is cheap to read; a non-stored computed field can run
  // arbitrary customer code on every query.
  if (!field.stored) score -= 0.25;

  if (score <= 0) return null;
  return { field, score: Math.min(score, 1), evidence };
}

export class DeterministicProposer implements MappingProposer {
  readonly id = "deterministic-v1";

  async propose(context: ProposerContext): Promise<MappingProposal> {
    const entities = proposeEntities(context.payload);
    const models = entityModelMap(entities);
    const byModel = new Map<string, SchemaField[]>();
    for (const field of context.payload.fields) {
      if (!byModel.has(field.model)) byModel.set(field.model, []);
      byModel.get(field.model)!.push(field);
    }

    const fields: FieldMappingProposal[] = [];
    const unmapped: string[] = [];

    for (const concept of CANONICAL_CONCEPTS) {
      const model = models.get(concept.entity);
      const candidates = model ? (byModel.get(model) ?? []) : [];

      const best = candidates
        .map((field) => scoreCandidate(concept, field))
        .filter((s): s is Scored => s !== null)
        .sort((a, b) => b.score - a.score);

      if (!best.length) {
        unmapped.push(concept.key);
        fields.push({
          canonicalField: concept.key,
          odooModel: null,
          odooField: null,
          relationPath: [],
          confidence: 0,
          evidence: [],
          alternatives: [],
          riskLevel: concept.riskLevel,
          explanation: {
            ar: "لم نجد حقلًا مناسبًا لهذا المفهوم في بياناتك.",
            en: "No suitable field for this concept was found in your data.",
          },
        });
        continue;
      }

      const top = best[0];
      fields.push({
        canonicalField: concept.key,
        odooModel: top.field.model,
        odooField: top.field.name,
        relationPath: [],
        confidence: top.score,
        evidence: top.evidence,
        alternatives: best.slice(1, 4).map((candidate) => ({
          odooModel: candidate.field.model,
          odooField: candidate.field.name,
          confidence: candidate.score,
          reason: candidate.field.label || candidate.field.name,
        })),
        riskLevel: concept.riskLevel,
        explanation: {
          ar: `مقترح من الحقل «${top.field.label || top.field.name}» في ${top.field.model}.`,
          en: `Proposed from "${top.field.label || top.field.name}" on ${top.field.model}.`,
        },
      });
    }

    return { schemaSnapshotId: context.snapshotId, entities, fields, unmapped };
  }
}

/** Concepts the deterministic pass could not resolve confidently. */
export function ambiguousConcepts(proposal: MappingProposal, threshold = 0.75): CanonicalConcept[] {
  const weak = new Set(
    proposal.fields.filter((f) => f.confidence < threshold).map((f) => f.canonicalField),
  );
  return CANONICAL_CONCEPTS.filter((concept) => weak.has(concept.key));
}

export function entityOf(conceptKey: string): CanonicalEntityKey | null {
  return CANONICAL_CONCEPTS.find((c) => c.key === conceptKey)?.entity ?? null;
}
