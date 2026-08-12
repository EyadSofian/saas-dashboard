// Schema snapshot contracts — the frozen description of one customer's Odoo.
//
// A snapshot is the ONLY thing a future mapping model may select paths from
// (ADR-0005). `label`, `help` and selection labels are customer-controlled
// strings: they are stored and displayed as data, and are never interpolated
// into instructions or into a query path (THREAT_MODEL T4).
import { z } from "zod";
import { permissionGapSchema } from "./odoo";
import { uuidSchema } from "./workspace";

export const ODOO_FIELD_TYPES = [
  "char",
  "text",
  "html",
  "integer",
  "float",
  "monetary",
  "boolean",
  "date",
  "datetime",
  "binary",
  "selection",
  "many2one",
  "one2many",
  "many2many",
  "reference",
  "json",
  "properties",
  "unknown",
] as const;

export type OdooFieldType = (typeof ODOO_FIELD_TYPES)[number];

export const selectionValueSchema = z.object({ value: z.string(), label: z.string() }).strict();

export const schemaFieldSchema = z
  .object({
    model: z.string(),
    name: z.string(),
    /** Translated label. UNTRUSTED customer data. */
    label: z.string(),
    /** Help text. UNTRUSTED customer data. */
    help: z.string().nullable(),
    type: z.enum(ODOO_FIELD_TYPES),
    relation: z.string().nullable(),
    relationField: z.string().nullable(),
    required: z.boolean(),
    readonly: z.boolean(),
    stored: z.boolean(),
    computed: z.boolean(),
    /** `x_`-prefixed or Studio-managed. */
    isCustom: z.boolean(),
    selectionValues: z.array(selectionValueSchema).nullable(),
  })
  .strict();

export type SchemaField = z.infer<typeof schemaFieldSchema>;

export const schemaModelSchema = z
  .object({
    model: z.string(),
    label: z.string(),
    /** Discovered directly from the allowlist, or reached through a relation. */
    origin: z.enum(["allowlist", "relation"]),
    accessible: z.boolean(),
    fieldCount: z.number().int().nonnegative(),
    recordCount: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type SchemaModel = z.infer<typeof schemaModelSchema>;

export const schemaRelationSchema = z
  .object({
    fromModel: z.string(),
    fromField: z.string(),
    toModel: z.string(),
    kind: z.enum(["many2one", "one2many", "many2many"]),
  })
  .strict();

export type SchemaRelation = z.infer<typeof schemaRelationSchema>;

/**
 * The hashed payload. Only these three collections feed `contentHash`, so
 * re-running discovery against unchanged metadata produces the same hash and
 * does not create a duplicate snapshot. Timestamps and ids are deliberately
 * excluded from the hash.
 */
export const snapshotPayloadSchema = z
  .object({
    models: z.array(schemaModelSchema),
    fields: z.array(schemaFieldSchema),
    relations: z.array(schemaRelationSchema),
  })
  .strict();

export type SnapshotPayload = z.infer<typeof snapshotPayloadSchema>;

export const schemaSnapshotSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    connectionId: uuidSchema,
    contractVersion: z.literal(1),
    odooVersion: z.string().nullable(),
    contentHash: z.string().length(64),
    modelCount: z.number().int().nonnegative(),
    fieldCount: z.number().int().nonnegative(),
    relationCount: z.number().int().nonnegative(),
    permissionGaps: z.array(permissionGapSchema),
    status: z.enum(["discovering", "ready", "failed"]),
    startedAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .strict();

export type SchemaSnapshot = z.infer<typeof schemaSnapshotSchema>;

/**
 * Sorting before hashing is what makes the hash independent of the order Odoo
 * happened to return things in.
 */
export function sortSnapshotPayload(payload: SnapshotPayload): SnapshotPayload {
  return {
    models: [...payload.models].sort((a, b) => a.model.localeCompare(b.model)),
    fields: [...payload.fields].sort(
      (a, b) => a.model.localeCompare(b.model) || a.name.localeCompare(b.name),
    ),
    relations: [...payload.relations].sort(
      (a, b) =>
        a.fromModel.localeCompare(b.fromModel) ||
        a.fromField.localeCompare(b.fromField) ||
        a.toModel.localeCompare(b.toModel),
    ),
  };
}
