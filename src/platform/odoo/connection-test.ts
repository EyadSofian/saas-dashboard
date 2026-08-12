// Connection test with per-model permission probes.
//
// Authentication succeeding proves the credentials work; it proves nothing about
// what the integration user may read. Read permission is therefore probed
// separately for every model in scope, and a denial is recorded as data
// (a PermissionGap) rather than raised as a failure.
import type {
  ConnectionTestResult,
  ConnectionTestState,
  PermissionGap,
  PermissionProbe,
} from "../contracts";
import { DISCOVERY_ALLOWLIST } from "./allowlist";
import { OdooError, withConnector, type OdooCredentials } from "./connector";
import { UnsafeUrlError } from "./url-guard";
import { safeErrorMessage } from "../audit/redact";

/** Under the 15 s objective for a healthy Odoo (PRD §10). */
const TEST_TIMEOUT_MS = 12_000;

// Keyed by the state union, not by `string`: a new state without a message is
// then a compile error rather than an undefined banner at runtime.
const MESSAGES: Record<ConnectionTestState, { ar: string; en: string }> = {
  success: {
    ar: "تم الاتصال بأودو بنجاح.",
    en: "Connected to Odoo successfully.",
  },
  invalid_url: {
    ar: "رابط أودو غير صالح. تأكد من أنه يبدأ بـ https.",
    en: "The Odoo URL is not valid. Make sure it starts with https.",
  },
  blocked_target: {
    ar: "لا يمكن الاتصال بهذا العنوان لأسباب أمنية.",
    en: "This address cannot be contacted for security reasons.",
  },
  unreachable: {
    ar: "تعذر الوصول إلى خادم أودو. تأكد من الرابط ومن أن الخادم يعمل.",
    en: "Could not reach the Odoo server. Check the URL and that the server is running.",
  },
  timeout: {
    ar: "لم يستجب خادم أودو في الوقت المحدد.",
    en: "The Odoo server did not respond in time.",
  },
  auth_failed: {
    ar: "رفض أودو بيانات الدخول. تأكد من اسم قاعدة البيانات واسم المستخدم ومفتاح الـ API.",
    en: "Odoo rejected the credentials. Check the database name, login and API key.",
  },
  access_denied: {
    ar: "تم الاتصال، لكن المستخدم لا يملك صلاحية القراءة المطلوبة.",
    en: "Connected, but the user does not have the required read permission.",
  },
  not_configured: {
    ar: "بيانات الاتصال غير مكتملة.",
    en: "The connection details are incomplete.",
  },
  credential_unreadable: {
    // Says what to do, not what went wrong internally: the reason is
    // deliberately indistinguishable, and the recovery is the same either way.
    ar: "تعذر فك تشفير مفتاح الـ API المحفوظ. أدخل المفتاح مرة أخرى ثم احفظ الاتصال.",
    en: "The stored API key could not be decrypted. Enter the API key again and save the connection.",
  },
};

/**
 * A failure state carrying no probe data, for callers that fail before the
 * connector is reached. Keeps those outcomes in the same shape the wizard
 * already renders instead of turning them into exceptions.
 */
export function connectionTestFailure(
  state: ConnectionTestState,
  checkedAt: string = new Date().toISOString(),
): ConnectionTestResult {
  return {
    ok: false,
    state,
    serverVersion: null,
    uid: null,
    probes: [],
    message: MESSAGES[state],
    checkedAt,
  };
}

function gapFor(
  model: string,
  operation: PermissionGap["operation"],
  error: unknown,
): PermissionGap {
  const reason: PermissionGap["reason"] =
    error instanceof OdooError
      ? error.kind === "access"
        ? "access_denied"
        : error.kind === "timeout"
          ? "timeout"
          : /does not exist|Object .* doesn't exist|Invalid model/i.test(error.message)
            ? "model_missing"
            : "error"
      : "error";
  return {
    model,
    operation,
    reason,
    detail: safeErrorMessage(error),
    observedAt: new Date().toISOString(),
  };
}

/**
 * Tests reachability, authentication, and read permission per model.
 *
 * Never throws for a connection problem — every failure mode is a state in the
 * result, because the wizard has to render each one differently.
 */
export async function testOdooConnection(
  credentials: OdooCredentials,
  options: { models?: readonly string[]; fetchImpl?: typeof fetch } = {},
): Promise<ConnectionTestResult> {
  const models = options.models ?? DISCOVERY_ALLOWLIST;
  const checkedAt = new Date().toISOString();
  const allowedModels = new Set<string>(models);

  const fail = (state: ConnectionTestState) => connectionTestFailure(state, checkedAt);

  try {
    return await withConnector(
      credentials,
      { timeoutMs: TEST_TIMEOUT_MS, attempts: 1, allowedModels, fetchImpl: options.fetchImpl },
      async (connector) => {
        let serverVersion: string | null = null;
        try {
          serverVersion = await connector.version();
        } catch (error) {
          if (error instanceof OdooError) {
            if (error.kind === "blocked") return fail("blocked_target");
            if (error.kind === "timeout") return fail("timeout");
            return fail("unreachable");
          }
          throw error;
        }

        let uid: number;
        try {
          uid = await connector.authenticate();
        } catch (error) {
          if (error instanceof OdooError) {
            if (error.kind === "auth") return fail("auth_failed");
            if (error.kind === "config") return fail("not_configured");
            if (error.kind === "timeout") return fail("timeout");
            return fail("unreachable");
          }
          throw error;
        }

        // Probe each model independently. One restricted model must not fail the
        // whole test — the customer needs to see exactly which ones are missing.
        const probes: PermissionProbe[] = [];
        for (const model of models) {
          let fieldCount: number | null = null;
          let recordCount: number | null = null;
          let gap: PermissionGap | null = null;

          try {
            fieldCount = Object.keys(await connector.fieldsGet(model)).length;
          } catch (error) {
            gap = gapFor(model, "fields_get", error);
          }

          if (!gap) {
            try {
              // search_count reads no records — only how many exist.
              recordCount = await connector.searchCount(model, []);
            } catch (error) {
              gap = gapFor(model, "search_count", error);
            }
          }

          probes.push({
            model,
            canRead: fieldCount !== null,
            canCount: recordCount !== null,
            fieldCount,
            recordCount,
            gap,
          });
        }

        const readable = probes.filter((p) => p.canRead).length;
        // Zero readable models means the credentials work but the user is
        // useless for analytics — a distinct, actionable state.
        const state = readable === 0 ? "access_denied" : "success";

        return {
          ok: state === "success",
          state,
          serverVersion,
          uid,
          probes,
          message: MESSAGES[state],
          checkedAt,
        };
      },
    );
  } catch (error) {
    if (error instanceof UnsafeUrlError) return fail("blocked_target");
    if (error instanceof OdooError) {
      if (error.kind === "blocked") return fail("blocked_target");
      if (error.kind === "config") return fail("not_configured");
      if (error.kind === "timeout") return fail("timeout");
      if (error.kind === "auth") return fail("auth_failed");
      return fail("unreachable");
    }
    return fail("invalid_url");
  }
}
