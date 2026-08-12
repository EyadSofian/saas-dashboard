// Snapshot validation — the control that stops a proposer inventing a path.
//
// A mapping model sees customer-controlled text (field labels, help strings)
// that may contain instructions aimed at it. Rather than trying to detect that,
// the design removes the payoff: whatever the model returns, every model, field
// and relation hop it names must exist in the exact snapshot it was given, or
// the mapping is dropped before it can be stored, displayed or approved.
import type { SchemaRelation, SnapshotPayload } from "../contracts";
import { CONCEPTS_BY_KEY } from "./concepts";
import type { FieldMappingProposal, MappingProposal } from "./contracts";

export interface ValidationIssue {
  canonicalField: string;
  reason:
    | "unknown_concept"
    | "unknown_model"
    | "unknown_field"
    | "unknown_relation"
    | "type_mismatch"
    | "path_too_deep";
  detail: string;
}

export interface ValidationResult {
  accepted: FieldMappingProposal[];
  rejected: ValidationIssue[];
}

/** Odoo field types that can carry each canonical concept type. */
const TYPE_COMPATIBILITY: Record<string, string[]> = {
  id: ["integer", "id"],
  text: ["char", "text", "html", "selection", "many2one"],
  number: ["integer", "float", "monetary"],
  money: ["monetary", "float"],
  date: ["date", "datetime"],
  datetime: ["datetime", "date"],
  boolean: ["boolean", "selection", "many2one", "char"],
  reference: ["many2one", "integer", "char"],
  selection: ["selection", "char", "many2one"],
};

const MAX_RELATION_DEPTH = 3;

export function buildSnapshotIndex(payload: SnapshotPayload) {
  const models = new Set(payload.models.filter((m) => m.accessible).map((m) => m.model));
  const fields = new Map<string, Map<string, string>>(); // model -> field -> type
  for (const field of payload.fields) {
    if (!fields.has(field.model)) fields.set(field.model, new Map());
    fields.get(field.model)!.set(field.name, field.type);
  }
  const relations = new Map<string, SchemaRelation[]>();
  for (const relation of payload.relations) {
    if (!relations.has(relation.fromModel)) relations.set(relation.fromModel, []);
    relations.get(relation.fromModel)!.push(relation);
  }
  return { models, fields, relations };
}

export type SnapshotIndex = ReturnType<typeof buildSnapshotIndex>;

/**
 * Walks a relation path from a starting model, confirming every hop exists in
 * the snapshot. Returns the model the path lands on, or null if any hop is
 * invented.
 */
export function resolveRelationPath(
  index: SnapshotIndex,
  startModel: string,
  path: string[],
): string | null {
  let current = startModel;
  for (const hop of path) {
    const relation = index.relations.get(current)?.find((r) => r.fromField === hop);
    if (!relation) return null;
    current = relation.toModel;
  }
  return current;
}

/**
 * Filters a proposal down to the mappings that actually exist in the snapshot.
 *
 * A rejected mapping is not an error — it is the expected outcome for a
 * hallucinated path, and it is recorded so the behaviour is measurable rather
 * than silent.
 */
export function validateProposal(
  proposal: MappingProposal,
  payload: SnapshotPayload,
  entityModels: Map<string, string>,
): ValidationResult {
  const index = buildSnapshotIndex(payload);
  const accepted: FieldMappingProposal[] = [];
  const rejected: ValidationIssue[] = [];

  for (const mapping of proposal.fields) {
    const concept = CONCEPTS_BY_KEY.get(mapping.canonicalField);
    if (!concept) {
      rejected.push({
        canonicalField: mapping.canonicalField,
        reason: "unknown_concept",
        detail: "Not a canonical concept in this product's catalog.",
      });
      continue;
    }

    // An explicitly unmapped concept is a legitimate answer, not a rejection:
    // "I could not find this" beats a confident wrong guess.
    if (!mapping.odooModel || !mapping.odooField) {
      accepted.push({ ...mapping, odooModel: null, odooField: null, confidence: 0 });
      continue;
    }

    if (mapping.relationPath.length > MAX_RELATION_DEPTH) {
      rejected.push({
        canonicalField: mapping.canonicalField,
        reason: "path_too_deep",
        detail: `Relation path of ${mapping.relationPath.length} hops exceeds the limit of ${MAX_RELATION_DEPTH}.`,
      });
      continue;
    }

    // The path must start at the entity's own model and every hop must exist.
    const entityModel = entityModels.get(concept.entity);
    if (entityModel && mapping.relationPath.length) {
      const landed = resolveRelationPath(index, entityModel, mapping.relationPath);
      if (landed === null) {
        rejected.push({
          canonicalField: mapping.canonicalField,
          reason: "unknown_relation",
          detail: `Relation path ${mapping.relationPath.join(".")} does not exist from ${entityModel}.`,
        });
        continue;
      }
      if (landed !== mapping.odooModel) {
        rejected.push({
          canonicalField: mapping.canonicalField,
          reason: "unknown_relation",
          detail: `Relation path lands on ${landed}, not ${mapping.odooModel}.`,
        });
        continue;
      }
    }

    if (!index.models.has(mapping.odooModel)) {
      rejected.push({
        canonicalField: mapping.canonicalField,
        reason: "unknown_model",
        detail: `Model ${mapping.odooModel} is not present or not readable in this snapshot.`,
      });
      continue;
    }

    const fieldType = index.fields.get(mapping.odooModel)?.get(mapping.odooField);
    if (!fieldType) {
      rejected.push({
        canonicalField: mapping.canonicalField,
        reason: "unknown_field",
        detail: `Field ${mapping.odooModel}.${mapping.odooField} does not exist in this snapshot.`,
      });
      continue;
    }

    const compatible = TYPE_COMPATIBILITY[concept.type] ?? [];
    if (compatible.length && !compatible.includes(fieldType)) {
      rejected.push({
        canonicalField: mapping.canonicalField,
        reason: "type_mismatch",
        detail: `${mapping.odooModel}.${mapping.odooField} is ${fieldType}, which cannot carry a ${concept.type} concept.`,
      });
      continue;
    }

    accepted.push(mapping);
  }

  return { accepted, rejected };
}
