// Error reporting.
//
// The concern here is not "send errors somewhere" — it is that an error report
// is the single most likely way a customer's Odoo credential leaves this system.
// A stack trace carries local variables, a request body carries the API key that
// was just submitted, and both go to a third party by design.
//
// So every payload passes through the same redaction the audit log uses, and a
// test asserts a canary credential cannot reach the wire. Sending nothing is
// better than sending a customer's key to a vendor.
//
// No SDK, for the same reason as the mailer: this sends a JSON envelope over
// HTTP. The SDK's breadcrumbs and source-map upload are worth having later, and
// the interface here does not change when they arrive.
import { redactSecrets, safeErrorMessage } from "../audit/redact";

export interface ErrorContext {
  /** Scoped, never identifying: a workspace id, not a customer name. */
  workspaceId?: string;
  operation?: string;
  extra?: Record<string, unknown>;
}

export interface ErrorReporter {
  readonly id: string;
  report(error: unknown, context?: ErrorContext): Promise<void>;
}

/** Fields whose contents are never sent, whatever they hold. */
const NEVER_SEND = /api[-_]?key|password|secret|token|authorization|credential|ciphertext|cookie/i;

/**
 * Strips a payload down to what is safe and still useful.
 *
 * Deliberately keeps: the message, the stack, and the operation. Those answer
 * "what broke and where". Deliberately drops: anything named like a credential,
 * and any registered secret value found anywhere in the structure.
 */
export function buildPayload(error: unknown, context: ErrorContext = {}) {
  const raw = error instanceof Error ? error : new Error(String(error));

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context.extra ?? {})) {
    if (NEVER_SEND.test(key)) continue;
    extra[key] = value;
  }

  // redactSecrets runs last so it also catches a live credential that was
  // concatenated into a message or a stack frame under an innocent name.
  return redactSecrets({
    message: safeErrorMessage(raw, 500),
    name: raw.name,
    stack: raw.stack?.split("\n").slice(0, 20).join("\n"),
    workspaceId: context.workspaceId,
    operation: context.operation,
    environment: (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").trim(),
    release: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7),
    extra,
  });
}

/** Discards everything. The default when no DSN is configured. */
export class NoopReporter implements ErrorReporter {
  readonly id = "noop";
  async report(_error?: unknown, _context?: ErrorContext): Promise<void> {}
}

/** Keeps reports in memory. Used by tests to inspect what would have been sent. */
export class MemoryReporter implements ErrorReporter {
  readonly id = "memory";
  readonly reports: Array<Record<string, unknown>> = [];

  async report(error: unknown, context: ErrorContext = {}): Promise<void> {
    this.reports.push(buildPayload(error, context) as Record<string, unknown>);
  }
}

/**
 * Sentry's store endpoint, addressed from the DSN.
 *
 * A DSN looks like `https://<key>@<host>/<project>`. The key is a public
 * ingestion key, not a secret — but it is still kept out of the payload and
 * sent only in the auth header.
 */
export class SentryReporter implements ErrorReporter {
  readonly id = "sentry";
  private readonly endpoint: string;
  private readonly key: string;

  constructor(
    dsn: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(dsn);
    this.key = url.username;
    const projectId = url.pathname.replace(/^\//, "");
    if (!this.key || !projectId) throw new Error("SENTRY_DSN is malformed.");
    this.endpoint = `${url.protocol}//${url.host}/api/${projectId}/store/`;
  }

  async report(error: unknown, context: ErrorContext = {}): Promise<void> {
    const payload = buildPayload(error, context) as Record<string, unknown>;

    await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${this.key}`,
      },
      body: JSON.stringify({
        message: payload.message,
        level: "error",
        platform: "node",
        environment: payload.environment,
        release: payload.release,
        // Tags are indexed and searchable; a workspace id makes "is this one
        // customer or everyone?" answerable in one click.
        tags: { workspace_id: payload.workspaceId, operation: payload.operation },
        extra: { stack: payload.stack, ...(payload.extra as object) },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  }
}

let reporter: ErrorReporter | null = null;

export function getErrorReporter(): ErrorReporter {
  if (reporter) return reporter;
  const dsn = process.env.SENTRY_DSN?.trim();

  if (!dsn) {
    // No DSN is a normal, supported state, not a misconfiguration. Reporting is
    // an operational convenience; refusing to run without it would make an
    // observability vendor a hard dependency of the product.
    reporter = new NoopReporter();
    return reporter;
  }

  try {
    reporter = new SentryReporter(dsn);
  } catch {
    reporter = new NoopReporter();
  }
  return reporter;
}

export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

/**
 * Reports without ever becoming the failure.
 *
 * Fire-and-forget and fully swallowed: an outage at the error tracker must not
 * turn a handled 500 into an unhandled one, and must not add latency to a
 * request that is already going badly.
 */
export function reportError(error: unknown, context: ErrorContext = {}): void {
  void getErrorReporter()
    .report(error, context)
    .catch(() => undefined);
}
