import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../fixtures/postgres";
import { migrateUp } from "@/platform/db/migrate";
import { closePool, getPool } from "@/platform/db/pool";

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
  process.env.DATABASE_URL = database.url;
  process.env.PUBLIC_APP_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "test-secret-that-is-long-enough-for-better-auth";
  process.env.REQUIRE_EMAIL_VERIFICATION = "0";
  await migrateUp();
}, 120_000);

afterAll(async () => {
  delete process.env.PUBLIC_APP_URL;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.REQUIRE_EMAIL_VERIFICATION;
  await closePool().catch(() => undefined);
  await database?.stop().catch(() => undefined);
});

describe("Better Auth PostgreSQL contract", () => {
  it("creates a user, credential account and session in the migrated schema", async () => {
    const { getAuth } = await import("@/platform/auth");
    const email = `auth-${crypto.randomUUID()}@example.test`;
    const response = await getAuth().handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Auth Contract", email, password: "correct-horse-123" }),
      }),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token");

    const user = await getPool().query<{ id: string; email_verified: boolean }>(
      "SELECT id::text, email_verified FROM users WHERE email = $1",
      [email],
    );
    expect(user.rows).toHaveLength(1);
    expect(user.rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(user.rows[0]?.email_verified).toBe(false);

    const account = await getPool().query(
      "SELECT 1 FROM accounts WHERE user_id = $1 AND provider_id = 'credential'",
      [user.rows[0]?.id],
    );
    const session = await getPool().query("SELECT 1 FROM sessions WHERE user_id = $1", [
      user.rows[0]?.id,
    ]);
    expect(account.rows).toHaveLength(1);
    expect(session.rows).toHaveLength(1);
  });
});
