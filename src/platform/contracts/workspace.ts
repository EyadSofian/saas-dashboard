// Workspace, organization and membership contracts.
//
// `workspace_id` is the product's only isolation key (ADR-0004). There is no
// `tenant_id` anywhere, and a security test asserts that.
import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const ROLES = [
  "workspace_owner",
  "data_admin",
  "financial_approver",
  "dashboard_publisher",
  "analyst",
  "viewer",
] as const;

export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

/**
 * Which roles may perform which operation. Checked in the application layer on
 * top of RLS — RLS decides which rows exist, this decides what may be done.
 */
export const ROLE_PERMISSIONS: Record<string, readonly Role[]> = {
  "workspace.read": [...ROLES],
  "workspace.manage": ["workspace_owner"],
  "membership.manage": ["workspace_owner"],
  "connection.read": ["workspace_owner", "data_admin", "analyst"],
  "connection.write": ["workspace_owner", "data_admin"],
  "connection.rotate_secret": ["workspace_owner"],
  "connection.test": ["workspace_owner", "data_admin"],
  "discovery.run": ["workspace_owner", "data_admin"],
  "snapshot.read": ["workspace_owner", "data_admin", "financial_approver", "analyst"],
  "policy.approve": ["workspace_owner", "financial_approver"],
  "dashboard.publish": ["workspace_owner", "dashboard_publisher"],
  "audit.read": ["workspace_owner", "data_admin"],
  "health.read": [...ROLES],
};

export type Permission = keyof typeof ROLE_PERMISSIONS;

export function roleGrants(roles: readonly Role[], permission: string): boolean {
  const allowed = ROLE_PERMISSIONS[permission];
  if (!allowed) return false; // Unknown permission fails closed.
  return roles.some((role) => allowed.includes(role));
}

/**
 * Resolved from the authenticated session's membership — never from request
 * input (TENANCY_INVARIANTS INV-5). Repositories refuse to build a query
 * without one.
 */
export const workspaceContextSchema = z
  .object({
    workspaceId: uuidSchema,
    organizationId: uuidSchema,
    userId: uuidSchema,
    roles: z.array(roleSchema).min(1),
  })
  .strict();

export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;

export const workspaceSchema = z
  .object({
    id: uuidSchema,
    organizationId: uuidSchema,
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    timezone: z.string().min(1).max(64),
    locale: z.enum(["ar-EG", "ar-SA", "ar", "en-US", "en"]),
    baseCurrency: z.string().length(3),
    industryPack: z.string().min(1).max(64).nullable(),
    onboardingState: z.enum([
      "draft",
      "connection_pending",
      "validating",
      "permission_failed",
      "discovering",
      "snapshot_ready",
      "failed",
    ]),
    createdAt: z.string(),
  })
  .strict();

export type Workspace = z.infer<typeof workspaceSchema>;

export const createWorkspaceInputSchema = z
  .object({
    organizationName: z.string().min(1).max(200),
    workspaceName: z.string().min(1).max(200),
    timezone: z.string().min(1).max(64).default("Africa/Cairo"),
    locale: z.enum(["ar-EG", "ar-SA", "ar", "en-US", "en"]).default("ar-EG"),
    baseCurrency: z.string().length(3).default("USD"),
    industryPack: z.string().min(1).max(64).optional(),
  })
  .strict();

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;
