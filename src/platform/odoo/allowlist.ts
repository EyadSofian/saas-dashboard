// What the connector is permitted to do (THREAT_MODEL T7).
//
// The legacy `odooCall()` forwards any model and any method to `execute_kw` —
// an arbitrary-write primitive against the customer's ERP. Acceptable when only
// first-party code calls it with a hardcoded config; unacceptable once customer
// configuration and (later) model output can influence arguments.
//
// A read-only Odoo user is necessary but NOT sufficient: an API key inherits its
// user's permissions, and "read-only" is a promise the customer made, not one we
// can verify. This allowlist is the control we actually enforce.

/** Methods the connector may invoke. Everything else is refused before any I/O. */
export const ALLOWED_METHODS = new Set([
  "fields_get",
  "search_count",
  "search_read",
  "read",
  "read_group",
]);

/** Methods named explicitly so a refusal reads clearly in logs and tests. */
export const FORBIDDEN_METHODS = new Set([
  "create",
  "write",
  "unlink",
  "copy",
  "name_create",
  "load",
  "import_data",
  "execute",
  "execute_kw",
  "browse",
  "search_fetch",
  "web_save",
  "onchange",
]);

/**
 * The authorized discovery scope. Discovery covers exactly these models plus the
 * models reached from them by a relation, after a permission check. It is never
 * broadened to every installed model.
 */
export const DISCOVERY_ALLOWLIST = [
  "crm.lead",
  "crm.stage",
  "crm.team",
  "sale.order",
  "sale.order.line",
  "account.move",
  "account.move.line",
  "account.payment",
  "account.partial.reconcile",
  "res.company",
  "res.currency",
  "res.users",
  "product.product",
  "product.template",
  "product.category",
] as const;

export type DiscoveryModel = (typeof DISCOVERY_ALLOWLIST)[number];

/**
 * Models a relation may legitimately point at. Discovery records relations to
 * anything, but only follows them into models on this list — otherwise one
 * many2one to `ir.attachment` would drag in the entire Odoo schema.
 */
export const RELATION_FOLLOW_ALLOWLIST = new Set<string>([
  ...DISCOVERY_ALLOWLIST,
  "res.partner",
  "res.country",
  "uom.uom",
  "account.journal",
  "account.account",
  "crm.lost.reason",
  "utm.campaign",
  "utm.source",
  "utm.medium",
]);

export class ForbiddenOdooCallError extends Error {
  constructor(
    message: string,
    readonly kind: "method" | "model",
  ) {
    super(message);
    this.name = "ForbiddenOdooCallError";
  }
}

const MODEL_NAME_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/**
 * Called before any network I/O. A rejection here means no request was made,
 * which is what makes this a real control rather than a filter.
 */
export function assertCallAllowed(model: string, method: string, allowedModels: Set<string>): void {
  if (!MODEL_NAME_RE.test(model)) {
    throw new ForbiddenOdooCallError(`Model name "${model}" is not a valid Odoo model.`, "model");
  }
  if (!ALLOWED_METHODS.has(method)) {
    throw new ForbiddenOdooCallError(
      `Method "${method}" is not permitted. The connector is read-only.`,
      "method",
    );
  }
  if (!allowedModels.has(model)) {
    throw new ForbiddenOdooCallError(
      `Model "${model}" is outside the approved scope for this workspace.`,
      "model",
    );
  }
}
