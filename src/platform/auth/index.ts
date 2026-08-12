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
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh at most daily
    },
    advanced: {
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
