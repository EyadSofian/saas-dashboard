// Odoo connection and permission-probe contracts.
//
// The API key is write-only across this whole boundary: it is accepted here and
// never appears in any response type (THREAT_MODEL T2).
import { z } from "zod";
import { uuidSchema } from "./workspace";

/** Submitted by the onboarding wizard. Server-only; never echoed back. */
export const odooConnectionInputSchema = z
  .object({
    baseUrl: z.string().min(1).max(2048),
    database: z
      .string()
      .min(1)
      .max(128)
      // Odoo database names are identifiers; control characters here are a
      // smuggling attempt, not a typo.
      .regex(/^[A-Za-z0-9._-]+$/, "Database name contains unsupported characters"),
    login: z.string().min(1).max(256),
    // Optional, because the key is write-only: a customer correcting the URL,
    // the database name or the login has no way to retype a credential the
    // browser was never given back. Omitting it means "keep the stored key",
    // and the API reuses the existing ciphertext rather than re-encrypting.
    //
    // The wizard always sends the field, so an empty string carries that same
    // meaning rather than being rejected as too short.
    apiKey: z
      .string()
      .max(512)
      .optional()
      .transform((value) => value || undefined),
  })
  .strict();

export type OdooConnectionInput = z.infer<typeof odooConnectionInputSchema>;

/**
 * What the API is allowed to return about a connection. Note the absence of any
 * secret field — `hasSecret` is the only thing said about the credential.
 */
export const odooConnectionPublicSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    baseUrl: z.string(),
    database: z.string(),
    login: z.string(),
    hasSecret: z.boolean(),
    secretAdapter: z.string(),
    status: z.enum(["draft", "validating", "connected", "permission_failed", "failed"]),
    lastTestedAt: z.string().nullable(),
    lastTestState: z.string().nullable(),
    odooVersion: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

export type OdooConnectionPublic = z.infer<typeof odooConnectionPublicSchema>;

export const CONNECTION_TEST_STATES = [
  "success",
  "invalid_url",
  "blocked_target",
  "unreachable",
  "timeout",
  "auth_failed",
  "access_denied",
  "not_configured",
  // The credential is stored but unreadable — a rotated root key, a restored
  // database, or tampered ciphertext. Odoo is never contacted, so this is a
  // test outcome with its own recovery step, not a server fault.
  "credential_unreadable",
] as const;

export type ConnectionTestState = (typeof CONNECTION_TEST_STATES)[number];

export const permissionGapSchema = z
  .object({
    model: z.string(),
    operation: z.enum(["read", "fields_get", "search_count", "search_read", "read_group"]),
    reason: z.enum(["access_denied", "model_missing", "timeout", "error"]),
    detail: z.string().max(300),
    observedAt: z.string(),
  })
  .strict();

export type PermissionGap = z.infer<typeof permissionGapSchema>;

export const permissionProbeSchema = z
  .object({
    model: z.string(),
    canRead: z.boolean(),
    canCount: z.boolean(),
    fieldCount: z.number().int().nonnegative().nullable(),
    // From search_count only. Discovery reads metadata, never records.
    recordCount: z.number().int().nonnegative().nullable(),
    gap: permissionGapSchema.nullable(),
  })
  .strict();

export type PermissionProbe = z.infer<typeof permissionProbeSchema>;

export const connectionTestResultSchema = z
  .object({
    ok: z.boolean(),
    state: z.enum(CONNECTION_TEST_STATES),
    serverVersion: z.string().nullable(),
    // Presence proves authentication succeeded. A uid is not a secret.
    uid: z.number().int().nullable(),
    probes: z.array(permissionProbeSchema),
    message: z.object({ ar: z.string(), en: z.string() }).strict(),
    checkedAt: z.string(),
  })
  .strict();

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
