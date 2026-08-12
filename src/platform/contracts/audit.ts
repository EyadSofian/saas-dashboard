// Audit and data-health contracts.
import { z } from "zod";
import { uuidSchema } from "./workspace";

export const auditEventSchema = z
  .object({
    workspaceId: uuidSchema,
    /** null means a system or background job acted, not a person. */
    actorUserId: uuidSchema.nullable(),
    action: z.string().min(1).max(128),
    targetType: z.string().min(1).max(64),
    targetId: z.string().max(128).nullable(),
    /** Passed through redactSecrets() before it is written, not before it is read. */
    metadata: z.record(z.unknown()),
    occurredAt: z.string(),
  })
  .strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;

export const AUDIT_ACTIONS = {
  workspaceCreated: "workspace.created",
  connectionCreated: "connection.created",
  connectionUpdated: "connection.updated",
  connectionSecretRotated: "connection.secret_rotated",
  connectionTested: "connection.tested",
  discoveryStarted: "discovery.started",
  discoveryCompleted: "discovery.completed",
  discoveryFailed: "discovery.failed",
  snapshotPublished: "snapshot.published",
  membershipGranted: "membership.granted",
} as const;

/**
 * `lastSuccessAt` and `lastAttemptAt` are separate on purpose: the audit found
 * a defect where a failed refresh advanced the freshness timestamp, so a broken
 * sync looked fresh. Freshness advances only on success.
 */
export const dataHealthStateSchema = z
  .object({
    workspaceId: uuidSchema,
    domain: z.string().min(1).max(64),
    status: z.enum(["never", "success", "stale", "failed"]),
    lastSuccessAt: z.string().nullable(),
    lastAttemptAt: z.string().nullable(),
    lastError: z.string().nullable(),
    rowCount: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type DataHealthState = z.infer<typeof dataHealthStateSchema>;
