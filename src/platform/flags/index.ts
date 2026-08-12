// Feature flags.
//
// With every flag at its default, the deployed product is exactly the current
// behaviour plus two unused nullable columns. See
// docs/product/CURRENT_TO_TARGET_MIGRATION_MAP.md §4.

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export const FLAGS = {
  /** `/api/v1/**`, onboarding UI, workspace navigation. Off => those routes 404. */
  workspaces: () => envFlag("FEATURE_WORKSPACES", false),
  /** Discovery job and snapshot viewer. Connection test works without it. */
  odooDiscovery: () => envFlag("FEATURE_ODOO_DISCOVERY", false),
  /** The 26 legacy routes and 14 legacy pages. Never turned off in this milestone. */
  legacyDashboard: () => envFlag("FEATURE_LEGACY_DASHBOARD", true),
} as const;

/** Thrown by route guards so a disabled feature is indistinguishable from absent. */
export class FeatureDisabledError extends Error {
  constructor(readonly flag: string) {
    super(`Feature ${flag} is disabled`);
    this.name = "FeatureDisabledError";
  }
}

export function requireFlag(flag: keyof typeof FLAGS): void {
  if (!FLAGS[flag]()) throw new FeatureDisabledError(flag);
}
