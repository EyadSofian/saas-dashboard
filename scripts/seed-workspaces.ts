// Seeds the reference workspace plus two synthetic workspaces.
//
// The two synthetic workspaces exist so the isolation tests have real, distinct
// data to prove separation with — an isolation test against an empty database
// proves nothing.
//
// Uses only synthetic data. Nothing here contacts production Odoo, the
// production database, or any external service.
import { closePool, databaseConfigured, withAdmin } from "../src/platform/db/pool.ts";

const REFERENCE_ORG = "00000000-0000-4000-8000-000000000000";
const REFERENCE_WORKSPACE = "00000000-0000-4000-8000-000000000001";

// Fixed ids so tests can reference them without a lookup.
const ALPHA_ORG = "00000000-0000-4000-8000-00000000000a";
const ALPHA_WORKSPACE = "00000000-0000-4000-8000-00000000001a";
const BETA_ORG = "00000000-0000-4000-8000-00000000000b";
const BETA_WORKSPACE = "00000000-0000-4000-8000-00000000001b";

const ALPHA_USER = "00000000-0000-4000-8000-0000000000a1";
const BETA_USER = "00000000-0000-4000-8000-0000000000b1";

if (!databaseConfigured()) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

try {
  await withAdmin(async (client) => {
    for (const [orgId, orgName, slug] of [
      [ALPHA_ORG, "Alpha Trading", "alpha-trading"],
      [BETA_ORG, "Beta Institute", "beta-institute"],
    ] as const) {
      await client.query(
        "INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",
        [orgId, orgName, slug],
      );
    }

    for (const [wsId, orgId, name, slug, pack] of [
      [ALPHA_WORKSPACE, ALPHA_ORG, "Alpha Trading — Production", "production", "general_b2b"],
      [BETA_WORKSPACE, BETA_ORG, "Beta Institute — Production", "production", "education"],
    ] as const) {
      await client.query(
        `INSERT INTO workspaces
           (id, organization_id, name, slug, timezone, locale, base_currency, industry_pack, onboarding_state)
         VALUES ($1,$2,$3,$4,'Africa/Cairo','ar-EG','USD',$5,'draft')
         ON CONFLICT (id) DO NOTHING`,
        [wsId, orgId, name, slug, pack],
      );
    }

    for (const [userId, email, name] of [
      [ALPHA_USER, "owner@alpha.test", "Alpha Owner"],
      [BETA_USER, "owner@beta.test", "Beta Owner"],
    ] as const) {
      await client.query(
        `INSERT INTO users (id, email, name, email_verified)
         VALUES ($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`,
        [userId, email, name],
      );
    }

    // Each user owns exactly one workspace. Neither has any membership in the
    // other's — that is what the isolation tests rely on.
    for (const [userId, orgId, wsId] of [
      [ALPHA_USER, ALPHA_ORG, ALPHA_WORKSPACE],
      [BETA_USER, BETA_ORG, BETA_WORKSPACE],
    ] as const) {
      await client.query(
        `INSERT INTO memberships (user_id, organization_id, workspace_id, roles)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, workspace_id) DO NOTHING`,
        [userId, orgId, wsId, ["workspace_owner", "data_admin"]],
      );
    }

    // Distinguishable per-workspace rows, so a leak is visible rather than
    // ambiguous.
    for (const [wsId, label] of [
      [REFERENCE_WORKSPACE, "reference"],
      [ALPHA_WORKSPACE, "alpha"],
      [BETA_WORKSPACE, "beta"],
    ] as const) {
      await client.query(
        `INSERT INTO onboarding_states (workspace_id, step, payload)
         VALUES ($1, 'profile', $2::jsonb)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [wsId, JSON.stringify({ seedLabel: label })],
      );
      for (const domain of ["discovery", "crm", "sales", "accounting"]) {
        await client.query(
          `INSERT INTO data_health_states (workspace_id, domain, status)
           VALUES ($1,$2,'never') ON CONFLICT (workspace_id, domain) DO NOTHING`,
          [wsId, domain],
        );
      }
    }

    console.log("Seeded workspaces:");
    console.log(`  reference  ${REFERENCE_WORKSPACE}  (Engosoft — education pack)`);
    console.log(`  alpha      ${ALPHA_WORKSPACE}  owner ${ALPHA_USER}`);
    console.log(`  beta       ${BETA_WORKSPACE}  owner ${BETA_USER}`);
  });

  // Confirm the reference workspace survived migration 0002.
  await withAdmin(async (client) => {
    const { rows } = await client.query(
      "SELECT name, industry_pack FROM workspaces WHERE id = $1",
      [REFERENCE_WORKSPACE],
    );
    if (!rows[0]) {
      console.error("Reference workspace missing — run `npm run db:migrate` first.");
      process.exit(1);
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await closePool();
}

export {
  ALPHA_WORKSPACE,
  ALPHA_USER,
  BETA_WORKSPACE,
  BETA_USER,
  REFERENCE_WORKSPACE,
  REFERENCE_ORG,
};
