// Authentication — ADR-0001.
//
// Better Auth on the existing PostgreSQL. Sessions are server-side records, not
// stateless JWTs, because break-glass expiry and role changes both need
// revocation.
//
// Authorization is NOT handled here: membership and roles live in our own
// tables, with RLS underneath (ADR-0004).
import { betterAuth } from "better-auth";
import { getPool } from "../db/pool";
import { emailVerificationRequired, trySend, verificationMessage } from "./mailer";

// Better Auth infers a literal options type, which does not unify with the
// declared `Auth<BetterAuthOptions>`. The concrete instance type is captured
// from the factory instead of being restated.
let instance: ReturnType<typeof createAuth> | null = null;

function createAuth() {
  return betterAuth({
    database: getPool(),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.PUBLIC_APP_URL ?? "http://localhost:3000",
    // The product schema deliberately uses conventional PostgreSQL plural
    // table names and snake_case columns. Better Auth defaults to singular
    // tables with camelCase columns, so keep the mapping explicit here. This
    // is part of the database contract, not a cosmetic naming preference.
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      modelName: "sessions",
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh at most daily
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    account: {
      modelName: "accounts",
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        idToken: "id_token",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    emailAndPassword: {
      enabled: true,
      // On by default. An analytics product that accepts any typed address will
      // happily send someone else's revenue to a typo.
      requireEmailVerification: emailVerificationRequired(),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      // One hour. Long enough to find the message, short enough that a link
      // sitting in an old inbox is not a standing way into the account.
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => {
        // A delivery failure must not leave a half-created account with no way
        // forward, so it is reported rather than thrown: Better Auth surfaces
        // the sign-up result and the user can request another link.
        await trySend(verificationMessage(user.email, url));
      },
    },
    advanced: {
      // Every identity primary key is PostgreSQL uuid. The Better Auth default
      // is an opaque text id, which PostgreSQL correctly rejects for our uuid
      // columns unless this is declared.
      database: { generateId: "uuid" },
      useSecureCookies: process.env.NODE_ENV === "production",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
  });
}

export function getAuth() {
  if (!instance) instance = createAuth();
  return instance;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Resolves the signed-in user from request cookies.
 *
 * Returns null rather than throwing so a route can distinguish "not signed in"
 * (401) from "signed in but not a member" (403) — two states the onboarding UI
 * has to render differently.
 */
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    if (!session?.user?.id) return null;
    return {
      id: String(session.user.id),
      email: String(session.user.email ?? ""),
      name: String(session.user.name ?? ""),
    };
  } catch {
    // A malformed or expired cookie is "not signed in", never an error page.
    return null;
  }
}
