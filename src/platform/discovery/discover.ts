// Metadata discovery over the authorized allowlist.
//
// Reads METADATA ONLY — model names, field names, labels, types, relations and
// selection values. It reads no records and computes no samples, so no PII can
// leave the customer's Odoo through this path (THREAT_MODEL T8). Profiling with
// redaction is Phase 2.
//
// Resumable: after each model the job checkpoints, so a crash or timeout
// continues at the next unprocessed model instead of rescanning.
import type { JobContext } from "../jobs";
import type {
  PermissionGap,
  SchemaField,
  SchemaModel,
  SchemaRelation,
  SnapshotPayload,
} from "../contracts";
import { contentHash, sortSnapshotPayload } from "../contracts";
import { DISCOVERY_ALLOWLIST, RELATION_FOLLOW_ALLOWLIST } from "../odoo/allowlist";
import { OdooError, type SafeOdooConnector } from "../odoo/connector";
import { safeErrorMessage } from "../audit/redact";
import { ODOO_FIELD_TYPES, type OdooFieldType } from "../contracts/schema-snapshot";

const FIELD_TYPES = new Set<string>(ODOO_FIELD_TYPES);

function normalizeType(raw: unknown): OdooFieldType {
  const value = String(raw ?? "").toLowerCase();
  return FIELD_TYPES.has(value) ? (value as OdooFieldType) : "unknown";
}

/**
 * Odoo `selection` arrives as `[[value, label], ...]`, or as a string naming a
 * method when the selection is computed. Only the literal form is usable.
 */
function normalizeSelection(raw: unknown): Array<{ value: string; label: string }> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<{ value: string; label: string }> = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length >= 2) {
      out.push({ value: String(entry[0]), label: String(entry[1]) });
    }
  }
  return out.length ? out : null;
}

/** Studio and hand-added fields are the ones a customer most needs explained. */
function isCustomField(name: string): boolean {
  return name.startsWith("x_") || name.startsWith("x_studio_");
}

export interface DiscoveryResult {
  payload: SnapshotPayload;
  permissionGaps: PermissionGap[];
  odooVersion: string | null;
  hash: string;
}

export interface DiscoveryCheckpoint {
  completedModels?: string[];
  /**
   * Every model queued so far, including ones reached through a relation.
   *
   * This must be checkpointed, not just recomputed from the allowlist: after a
   * resume the already-completed source models are skipped, so their relations
   * are never walked again. Without the queue, a relation-only model such as
   * `res.partner` would silently vanish from a resumed snapshot.
   */
  queuedModels?: Array<{ model: string; origin: SchemaModel["origin"] }>;
  models?: SchemaModel[];
  fields?: SchemaField[];
  relations?: SchemaRelation[];
  gaps?: PermissionGap[];
  odooVersion?: string | null;
  [key: string]: unknown;
}

function gapFor(
  model: string,
  operation: PermissionGap["operation"],
  error: unknown,
): PermissionGap {
  const reason: PermissionGap["reason"] =
    error instanceof OdooError
      ? error.kind === "access"
        ? "access_denied"
        : error.kind === "timeout"
          ? "timeout"
          : /does not exist|doesn't exist|Invalid model/i.test(error.message)
            ? "model_missing"
            : "error"
      : "error";
  return {
    model,
    operation,
    reason,
    detail: safeErrorMessage(error),
    observedAt: new Date().toISOString(),
  };
}

export interface DiscoverOptions {
  models?: readonly string[];
  /** Follow relations into allowlisted models not in the initial set. */
  followRelations?: boolean;
  ctx?: Pick<JobContext, "checkpoint" | "resumeFrom" | "signal">;
}

/**
 * Discovers metadata for the allowlisted models, then optionally one hop into
 * related allowlisted models.
 *
 * A model that cannot be read records a PermissionGap and discovery continues —
 * the one deliberate fail-open in this milestone (THREAT_MODEL §4). A restricted
 * model must not cost the customer their entire scan.
 */
export async function discoverSchema(
  connector: SafeOdooConnector,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const requested = options.models ?? DISCOVERY_ALLOWLIST;
  const resume = (options.ctx?.resumeFrom ?? {}) as DiscoveryCheckpoint;

  const completed = new Set<string>(resume.completedModels ?? []);
  const models: SchemaModel[] = [...(resume.models ?? [])];
  const fields: SchemaField[] = [...(resume.fields ?? [])];
  const relations: SchemaRelation[] = [...(resume.relations ?? [])];
  const gaps: PermissionGap[] = [...(resume.gaps ?? [])];
  let odooVersion: string | null = resume.odooVersion ?? null;

  if (odooVersion === null) {
    try {
      odooVersion = await connector.version();
    } catch {
      odooVersion = null; // Version is informational; never fail discovery on it.
    }
  }

  // Rebuild the full queue from the checkpoint when resuming, so relation-only
  // models survive an interruption; fall back to the allowlist on a fresh run.
  const queue: Array<{ model: string; origin: SchemaModel["origin"] }> = resume.queuedModels?.length
    ? [...resume.queuedModels]
    : requested.map((model) => ({ model, origin: "allowlist" as const }));
  const queued = new Set<string>(queue.map((entry) => entry.model));
  for (const model of requested) {
    if (!queued.has(model)) {
      queued.add(model);
      queue.push({ model, origin: "allowlist" });
    }
  }

  const snapshotCheckpoint = (): DiscoveryCheckpoint => ({
    completedModels: [...completed],
    queuedModels: queue.filter((entry) => !completed.has(entry.model)),
    models,
    fields,
    relations,
    gaps,
    odooVersion,
  });

  while (queue.length) {
    if (options.ctx?.signal?.aborted) break;
    // Peek rather than shift: the entry is removed only once the model is
    // recorded, so an abort mid-model leaves it in the checkpointed queue and
    // the resumed run picks it up again.
    const { model, origin } = queue[0];
    if (completed.has(model)) {
      queue.shift();
      continue;
    }

    let raw: Record<string, Record<string, unknown>> | null = null;
    try {
      raw = await connector.fieldsGet(model);
    } catch (error) {
      gaps.push(gapFor(model, "fields_get", error));
      models.push({
        model,
        label: model,
        origin,
        accessible: false,
        fieldCount: 0,
        recordCount: null,
      });
      completed.add(model);
      queue.shift();
      await options.ctx?.checkpoint?.(snapshotCheckpoint());
      continue;
    }

    let recordCount: number | null = null;
    try {
      recordCount = await connector.searchCount(model, []);
    } catch (error) {
      // Countable-but-not-readable is worth recording, but it does not make the
      // model's metadata useless.
      gaps.push(gapFor(model, "search_count", error));
    }

    for (const [name, attrs] of Object.entries(raw)) {
      const type = normalizeType(attrs.type);
      const relation = attrs.relation ? String(attrs.relation) : null;

      fields.push({
        model,
        name,
        // Customer-controlled strings. Stored as data; never interpolated.
        label: String(attrs.string ?? name),
        help: attrs.help ? String(attrs.help) : null,
        type,
        relation,
        relationField: attrs.relation_field ? String(attrs.relation_field) : null,
        required: Boolean(attrs.required),
        readonly: Boolean(attrs.readonly),
        // Odoo omits `store` for stored fields in some versions; absent means stored.
        stored: attrs.store === undefined ? true : Boolean(attrs.store),
        computed: Array.isArray(attrs.depends) && attrs.depends.length > 0,
        isCustom: isCustomField(name),
        selectionValues: type === "selection" ? normalizeSelection(attrs.selection) : null,
      });

      if (relation && (type === "many2one" || type === "one2many" || type === "many2many")) {
        relations.push({ fromModel: model, fromField: name, toModel: relation, kind: type });
        if (
          options.followRelations !== false &&
          RELATION_FOLLOW_ALLOWLIST.has(relation) &&
          !queued.has(relation)
        ) {
          queued.add(relation);
          queue.push({ model: relation, origin: "relation" });
        }
      }
    }

    models.push({
      model,
      label: model,
      origin,
      accessible: true,
      fieldCount: Object.keys(raw).length,
      recordCount,
    });
    completed.add(model);
    queue.shift();

    await options.ctx?.checkpoint?.(snapshotCheckpoint());
  }

  // Sorting before hashing makes the hash independent of the order Odoo
  // happened to answer in, so an unchanged Odoo always produces the same hash.
  const payload = sortSnapshotPayload({ models, fields, relations });
  return { payload, permissionGaps: gaps, odooVersion, hash: contentHash(payload) };
}
