// Feature flags.
//
// There is no legacy-dashboard flag: this product has no legacy dashboard to
// keep alive. Flags here gate genuinely optional or not-yet-hardened behaviour.

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export const FLAGS = {
  /** Odoo metadata discovery. On by default — it is core onboarding. */
  odooDiscovery: () => envFlag("FEATURE_ODOO_DISCOVERY", true),
  /**
   * AI-proposed semantic mappings. Off without an API key, because a missing
   * key should degrade to the deterministic proposer rather than error.
   */
  aiMapping: () => envFlag("FEATURE_AI_MAPPING", Boolean(process.env.OPENAI_API_KEY?.trim())),
  /** Odoo data sync into the canonical layer. */
  sync: () => envFlag("FEATURE_SYNC", true),
  /** The dashboard builder UI. */
  dashboardBuilder: () => envFlag("FEATURE_DASHBOARD_BUILDER", true),
} as const;

export class FeatureDisabledError extends Error {
  constructor(readonly flag: string) {
    super(`Feature ${flag} is disabled`);
    this.name = "FeatureDisabledError";
  }
}

export function requireFlag(flag: keyof typeof FLAGS): void {
  if (!FLAGS[flag]()) throw new FeatureDisabledError(flag);
}
