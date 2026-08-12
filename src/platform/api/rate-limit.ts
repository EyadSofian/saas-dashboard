// Per-workspace rate limiting.
//
// The limits that matter are not "requests per second" — they are the
// operations that cost someone else something. A discovery scan hammers a
// customer's Odoo. A sync holds a worker. An AI call costs money. A metric
// query costs database time shared with every other workspace.
//
// Backed by PostgreSQL rather than memory, for the same reason the job queue is:
// an in-memory counter resets on deploy and is per-replica, so the limit it
// enforces is whatever a restart last left behind.
import { withWorkspace } from "../db/pool";
import type { WorkspaceContext } from "../contracts";

export type RateLimitKey =
  "discovery" | "sync" | "connection_test" | "copilot" | "ai_mapping" | "metric_query" | "export";

interface Budget {
  /** How many are allowed inside the window. */
  max: number;
  windowSeconds: number;
  /** Why this number, so a future change is an argument rather than a guess. */
  rationale: string;
}

const BUDGETS: Record<RateLimitKey, Budget> = {
  discovery: {
    max: 6,
    windowSeconds: 3600,
    rationale: "A full scan touches the customer's Odoo hard; six an hour is generous for retries.",
  },
  sync: {
    max: 12,
    windowSeconds: 3600,
    rationale: "Above the fastest plan's 15-minute floor, leaving room for manual refreshes.",
  },
  connection_test: {
    max: 20,
    windowSeconds: 600,
    rationale: "Onboarding involves real trial and error; this only stops a script.",
  },
  copilot: {
    max: 60,
    windowSeconds: 3600,
    rationale: "Each answer costs a model call. A person asks a few; a loop asks thousands.",
  },
  ai_mapping: {
    max: 20,
    windowSeconds: 3600,
    rationale: "Re-proposing a mapping is rare and expensive.",
  },
  metric_query: {
    max: 600,
    windowSeconds: 60,
    rationale: "A dashboard fires ~10 on load; this allows heavy use but not a scraper.",
  },
  export: {
    max: 5,
    windowSeconds: 3600,
    rationale: "An export reads the whole workspace. Five an hour is more than anyone needs.",
  },
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
}

/**
 * Consumes one unit of budget.
 *
 * Counts rows already written in the window rather than keeping a counter, so
 * there is nothing to reset, nothing to drift, and no separate state to keep
 * consistent with what actually happened.
 */
export async function consumeRateLimit(
  context: WorkspaceContext,
  key: RateLimitKey,
): Promise<RateLimitResult> {
  const budget = BUDGETS[key];
  if (!budget) {
    // An unknown operation is refused rather than allowed unlimited.
    return { allowed: false, remaining: 0, limit: 0, retryAfterSeconds: 60 };
  }

  return withWorkspace(context, async (client) => {
    const { rows } = await client.query<{ used: string; oldest: string | null }>(
      `SELECT count(*)::text AS used, min(occurred_at)::text AS oldest
         FROM usage_events
        WHERE workspace_id = $1
          AND kind = $2
          AND occurred_at > now() - make_interval(secs => $3)`,
      [context.workspaceId, `rate:${key}`, budget.windowSeconds],
    );

    const used = Number(rows[0]?.used ?? 0);
    if (used >= budget.max) {
      // Retry when the oldest event in the window ages out, not after a fixed
      // delay — so a client that waits exactly that long succeeds.
      const oldest = rows[0]?.oldest ? Date.parse(rows[0].oldest) : Date.now();
      const retryAfter = Math.max(
        1,
        Math.ceil((oldest + budget.windowSeconds * 1000 - Date.now()) / 1000),
      );
      return { allowed: false, remaining: 0, limit: budget.max, retryAfterSeconds: retryAfter };
    }

    await client.query(
      `INSERT INTO usage_events (workspace_id, kind, quantity) VALUES ($1, $2, 1)`,
      [context.workspaceId, `rate:${key}`],
    );

    return {
      allowed: true,
      remaining: budget.max - used - 1,
      limit: budget.max,
      retryAfterSeconds: 0,
    };
  });
}

/** A 429 carrying the headers a well-behaved client already knows how to read. */
export function rateLimitResponse(result: RateLimitResult, key: RateLimitKey): Response {
  return Response.json(
    {
      ok: false,
      error: "Too many requests for this workspace. Please wait and try again.",
      operation: key,
      retryAfterSeconds: result.retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(result.retryAfterSeconds),
        "x-ratelimit-limit": String(result.limit),
        "x-ratelimit-remaining": "0",
      },
    },
  );
}

export function rateLimitBudget(key: RateLimitKey): Budget | undefined {
  return BUDGETS[key];
}
