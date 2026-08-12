// Database access with workspace context.
//
// Every workspace query runs inside a transaction that sets `app.workspace_id`
// with SET LOCAL. SET LOCAL unwinds at COMMIT/ROLLBACK, so a pooled connection
// cannot carry one workspace's context into another request (INV-4).
//
// Session-scoped `SET` is banned here and asserted against by the isolation
// tests.
import { Pool, type PoolClient } from "pg";
import type { WorkspaceContext } from "../contracts";

let pool: Pool | null = null;

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || undefined;
}

export function databaseConfigured(): boolean {
  return Boolean(databaseUrl());
}

export function getPool(): Pool {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  if (!pool) {
    // Railway's private network and a local PostgreSQL both speak plain TCP;
    // demanding SSL there fails with "the server does not support SSL
    // connections". Everything else — any real remote host — keeps TLS.
    const isInternal = connectionString.includes(".railway.internal");
    const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      ssl:
        isInternal || isLocal || process.env.PGSSLMODE === "disable"
          ? false
          : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

/** Raised when workspace-scoped work is attempted without a resolved context. */
export class MissingWorkspaceContextError extends Error {
  constructor() {
    super("Workspace context is required for this query");
    this.name = "MissingWorkspaceContextError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction scoped to one workspace.
 *
 * The workspace id is validated as a UUID before it reaches `set_config`. It is
 * still passed as a bound parameter rather than interpolated — belt and braces,
 * because this is the one string that decides which customer's data is visible.
 */
export async function withWorkspace<T>(
  context: WorkspaceContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!context?.workspaceId || !UUID_RE.test(context.workspaceId)) {
    throw new MissingWorkspaceContextError();
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // `true` = local to this transaction.
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [context.workspaceId]);
    if (context.userId && UUID_RE.test(context.userId)) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * For the one legitimate pre-workspace query: listing the workspaces a signed-in
 * user may enter. Sets `app.user_id` only, so the RLS policies on `workspaces`
 * and `memberships` expose exactly that user's own memberships and nothing else.
 */
export async function withUser<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!userId || !UUID_RE.test(userId)) throw new MissingWorkspaceContextError();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Admin-role access with NO workspace context: migrations, provisioning and
 * platform-wide queries only. Every call site must be justified in review —
 * this is the one door that RLS does not stand behind.
 */
export async function withAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
