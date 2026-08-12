// Per-workspace, allowlisted, read-only Odoo JSON-RPC connector.
//
// Differences from the legacy `src/lib/odoo.server.ts`, all deliberate:
//   • credentials are passed in per call site, not read from process.env
//   • no generic passthrough — model and method are allowlisted before any I/O
//   • the URL is SSRF-validated before the first request
//   • redirects are refused and the response body is size-bounded
//   • the API key is registered for redaction for the lifetime of every call
import { assertCallAllowed, ForbiddenOdooCallError } from "./allowlist";
import { assertSafeOdooUrl, UnsafeUrlError, type SafeUrl } from "./url-guard";
import { safeErrorMessage, withSecretRedacted } from "../audit/redact";

export interface OdooCredentials {
  baseUrl: string;
  database: string;
  login: string;
  apiKey: string;
}

export type OdooErrorKind =
  "auth" | "access" | "server" | "network" | "timeout" | "config" | "blocked" | "too_large";

export class OdooError extends Error {
  constructor(
    message: string,
    readonly kind: OdooErrorKind = "server",
  ) {
    super(message);
    this.name = "OdooError";
  }
}

/** 8 MB. A metadata response is a few hundred KB; anything larger is abusive. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface ConnectorOptions {
  timeoutMs?: number;
  attempts?: number;
  /** Models this connector instance may touch. Required — there is no default-all. */
  allowedModels: Set<string>;
  fetchImpl?: typeof fetch;
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new OdooError("The Odoo response was too large.", "too_large");
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new OdooError("The Odoo response was too large.", "too_large");
  }
  return text;
}

export class SafeOdooConnector {
  private uid: number | null = null;
  private safeUrl: SafeUrl | null = null;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly allowedModels: Set<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly credentials: OdooCredentials,
    options: ConnectorOptions,
  ) {
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
    this.attempts = Math.max(1, options.attempts ?? 3);
    this.allowedModels = options.allowedModels;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Resolves and validates the URL once per connector instance. */
  private async endpoint(): Promise<string> {
    if (!this.safeUrl) {
      try {
        this.safeUrl = await assertSafeOdooUrl(this.credentials.baseUrl);
      } catch (error) {
        if (error instanceof UnsafeUrlError) {
          throw new OdooError(error.message, "blocked");
        }
        throw error;
      }
    }
    return `${this.safeUrl.origin}/jsonrpc`;
  }

  private async rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
    const url = await this.endpoint();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: { service, method, args },
          id: Math.floor(Math.random() * 1e9),
        }),
        // A redirect could send the request — and the credentials in its body —
        // to an address that never passed the SSRF check.
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new OdooError("Odoo did not respond in time.", "timeout");
      }
      throw new OdooError(`Could not reach Odoo: ${safeErrorMessage(error, 120)}`, "network");
    }

    if (response.status >= 300 && response.status < 400) {
      throw new OdooError("Odoo redirected the request; refusing to follow.", "blocked");
    }
    if (!response.ok) {
      throw new OdooError(`Odoo responded ${response.status}.`, "server");
    }

    const text = await readBounded(response);
    let body: {
      result?: unknown;
      error?: { message?: string; data?: { message?: string; name?: string } };
    };
    try {
      body = JSON.parse(text);
    } catch {
      throw new OdooError("Odoo returned a response that was not JSON.", "server");
    }

    if (body.error) {
      const detail = String(body.error.data?.message || body.error.message || "Odoo error").trim();
      const errorName = String(body.error.data?.name || "");
      const kind: OdooErrorKind = /AccessError|AccessDenied/i.test(errorName)
        ? "access"
        : /Missing|KeyError|does not exist/i.test(detail)
          ? "server"
          : "server";
      // Odoo access errors are multi-line and leak internals in the tail.
      throw new OdooError(safeErrorMessage(detail), kind);
    }
    return body.result;
  }

  /** `common.version` — no credentials involved, so it is the cheapest reachability probe. */
  async version(): Promise<string | null> {
    const result = (await this.rpc("common", "version", [])) as
      { server_version?: string } | undefined;
    return result?.server_version ?? null;
  }

  async authenticate(): Promise<number> {
    if (this.uid !== null) return this.uid;
    const { database, login, apiKey } = this.credentials;
    if (!database || !login || !apiKey) {
      throw new OdooError("The Odoo connection is not fully configured.", "config");
    }
    const result = await this.rpc("common", "authenticate", [database, login, apiKey, {}]);
    if (typeof result !== "number" || !result) {
      throw new OdooError("Odoo rejected these credentials.", "auth");
    }
    this.uid = result;
    return result;
  }

  /**
   * The only path to `execute_kw`. `assertCallAllowed` runs before authentication
   * so a forbidden call costs no network round trip at all.
   */
  async call<T>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<T> {
    assertCallAllowed(model, method, this.allowedModels);
    const uid = await this.authenticate();
    const { database, apiKey } = this.credentials;

    let lastError: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      try {
        return (await this.rpc("object", "execute_kw", [
          database,
          uid,
          apiKey,
          model,
          method,
          args,
          kwargs,
        ])) as T;
      } catch (error) {
        lastError = error;
        // Retrying a permission or configuration failure only burns time; and a
        // blocked target must never be retried at all.
        if (
          error instanceof OdooError &&
          (error.kind === "access" || error.kind === "config" || error.kind === "blocked")
        ) {
          throw error;
        }
        if (error instanceof ForbiddenOdooCallError) throw error;
        if (attempt < this.attempts - 1) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new OdooError("The Odoo call failed.", "network");
  }

  async fieldsGet(model: string): Promise<Record<string, Record<string, unknown>>> {
    // `fields_get` is not paginated; it returns the whole field dictionary.
    return this.call<Record<string, Record<string, unknown>>>(model, "fields_get", [], {
      attributes: [
        "string",
        "help",
        "type",
        "relation",
        "relation_field",
        "required",
        "readonly",
        "store",
        "selection",
        "depends",
      ],
    });
  }

  async searchCount(model: string, domain: unknown[] = []): Promise<number> {
    return this.call<number>(model, "search_count", [domain]);
  }
}

/**
 * Runs `fn` with the API key registered for redaction, so the key cannot appear
 * in a log line, trace, audit record or error message raised inside it.
 */
export async function withConnector<T>(
  credentials: OdooCredentials,
  options: ConnectorOptions,
  fn: (connector: SafeOdooConnector) => Promise<T>,
): Promise<T> {
  return withSecretRedacted(credentials.apiKey, () =>
    fn(new SafeOdooConnector(credentials, options)),
  );
}
