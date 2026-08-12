// Extraction plans, generated from the approved manifest.
//
// A plan names exactly which Odoo model to read, which fields to ask for, and
// where each field lands in the canonical layer. It is derived — never
// hand-written per customer, and never wider than what was approved: an
// unapproved mapping contributes no field, so unreviewed data cannot leak into
// a dashboard by accident.
import { CONCEPTS_BY_KEY, type CanonicalEntityKey } from "../semantic/concepts";
import type { StoredMapping } from "../semantic/repository";

export interface ExtractionPlan {
  entity: CanonicalEntityKey;
  odooModel: string;
  /** Odoo fields to request. Always includes id and write_date. */
  fields: string[];
  /** canonical concept key -> Odoo field name on this model. */
  columns: Record<string, string>;
  /** Canonical table the rows land in. */
  target: string;
  /** Domain restricting what is read, from approved policy. */
  domain: unknown[];
}

/** Which canonical table each entity lands in. */
const TARGETS: Partial<Record<CanonicalEntityKey, string>> = {
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

export interface PlanInput {
  mappings: StoredMapping[];
  entityModels: Map<string, string>;
  policies: Record<string, string>;
}

/**
 * Builds one plan per entity that has at least one approved mapping.
 *
 * Only `approved` mappings are included. A mapping still under review is not a
 * "probably fine" — it is a definition nobody has agreed to, and reading data
 * through it would put unreviewed numbers in front of an owner.
 */
export function buildExtractionPlans(input: PlanInput): ExtractionPlan[] {
  const byEntity = new Map<CanonicalEntityKey, StoredMapping[]>();

  for (const mapping of input.mappings) {
    if (mapping.status !== "approved" || !mapping.odooField) continue;
    const concept = CONCEPTS_BY_KEY.get(mapping.canonicalField);
    if (!concept) continue;
    // Cross-model paths need a join the extractor does not yet perform; they
    // are skipped rather than silently read from the wrong model.
    const entityModel = input.entityModels.get(concept.entity);
    if (!entityModel || mapping.odooModel !== entityModel) continue;

    if (!byEntity.has(concept.entity)) byEntity.set(concept.entity, []);
    byEntity.get(concept.entity)!.push(mapping);
  }

  const plans: ExtractionPlan[] = [];

  for (const [entity, mappings] of byEntity) {
    const odooModel = input.entityModels.get(entity);
    const target = TARGETS[entity];
    if (!odooModel || !target) continue;

    const columns: Record<string, string> = {};
    for (const mapping of mappings) columns[mapping.canonicalField] = mapping.odooField!;

    // `write_date` is what makes an incremental sync possible at all, and `id`
    // is the stable key, so both are always requested regardless of mapping.
    const fields = [...new Set(["id", "write_date", ...Object.values(columns)])];

    plans.push({
      entity,
      odooModel,
      fields,
      columns,
      target,
      domain: domainFor(entity, input.policies),
    });
  }

  // Dimensions first: facts reference them, and a fact row whose dimension is
  // missing renders as an id instead of a name.
  const order: CanonicalEntityKey[] = [
    "company",
    "currency",
    "user",
    "team",
    "partner",
    "product",
    "stage",
    "lead",
    "order",
    "orderLine",
    "invoice",
    "payment",
  ];
  return plans.sort((a, b) => order.indexOf(a.entity) - order.indexOf(b.entity));
}

/**
 * The Odoo domain for an entity, derived from approved policy.
 *
 * Domains are built here from a closed set of options — never from customer
 * text or model output — so nothing can widen a read beyond what was approved.
 */
function domainFor(entity: CanonicalEntityKey, policies: Record<string, string>): unknown[] {
  if (entity === "order" && policies.orderCounting === "confirmed_only") {
    return [["state", "in", ["sale", "done"]]];
  }
  if (entity === "invoice") {
    // Draft entries are not revenue under any policy, and vendor bills are not
    // customer revenue at all.
    return [
      ["move_type", "in", ["out_invoice", "out_refund"]],
      ["state", "=", "posted"],
    ];
  }
  return [];
}

/** Metrics that cannot be computed because their inputs were never approved. */
export function unavailableEntities(plans: ExtractionPlan[]): CanonicalEntityKey[] {
  const planned = new Set(plans.map((p) => p.entity));
  return (Object.keys(TARGETS) as CanonicalEntityKey[]).filter((e) => !planned.has(e));
}
