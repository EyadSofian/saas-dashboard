// Resumable Odoo onboarding wizard.
//
// State lives on the server (`workspaces.onboarding_state` + the connection
// row), not in component state, so a reload, a crash or a different device
// resumes exactly where the customer left off — milestone acceptance D.
//
// Arabic is first-class here, not a translation pass: the layout mirrors, the
// copy is written in Arabic, and technical values (URLs, model names) stay LTR
// inside an RTL sentence.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Database,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";

type OnboardingState =
  | "draft"
  | "connection_pending"
  | "validating"
  | "permission_failed"
  | "discovering"
  | "snapshot_ready"
  | "failed";

interface PermissionProbe {
  model: string;
  canRead: boolean;
  canCount: boolean;
  fieldCount: number | null;
  recordCount: number | null;
  gap: { reason: string; detail: string } | null;
}

interface ConnectionTestResult {
  ok: boolean;
  state: string;
  serverVersion: string | null;
  probes: PermissionProbe[];
  message: { ar: string; en: string };
  checkedAt: string;
}

interface Connection {
  id: string;
  baseUrl: string;
  database: string;
  login: string;
  hasSecret: boolean;
  status: string;
  lastTestState: string | null;
  odooVersion: string | null;
}

interface SnapshotSummary {
  id: string;
  contentHash: string;
  modelCount: number;
  fieldCount: number;
  relationCount: number;
  permissionGaps: Array<{ model: string; reason: string }>;
  completedAt: string | null;
}

const STEPS = [
  { key: "connection", ar: "الاتصال بأودو", en: "Connect Odoo", icon: Database },
  { key: "permissions", ar: "التحقق من الصلاحيات", en: "Check permissions", icon: Lock },
  { key: "discovery", ar: "قراءة بنية البيانات", en: "Read data structure", icon: RefreshCw },
  { key: "review", ar: "مراجعة النتيجة", en: "Review result", icon: CheckCircle2 },
] as const;

/** Which wizard step a server-side onboarding state corresponds to. */
function stepIndexFor(state: OnboardingState): number {
  switch (state) {
    case "draft":
    case "connection_pending":
      return 0;
    case "validating":
    case "permission_failed":
      return 1;
    case "discovering":
      return 2;
    case "snapshot_ready":
      return 3;
    case "failed":
      return 1;
  }
}

function api(path: string, workspaceId: string, init: RequestInit = {}) {
  return fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-workspace-id": workspaceId,
      ...(init.headers ?? {}),
    },
  });
}

export function OnboardingWizard({ workspaceId }: { workspaceId: string }) {
  const { lang } = useI18n();
  const ar = lang === "ar";

  const [state, setState] = useState<OnboardingState>("draft");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotSummary | null>(null);
  const [busy, setBusy] = useState<null | "saving" | "testing" | "discovering">(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [form, setForm] = useState({ baseUrl: "", database: "", login: "", apiKey: "" });

  /** Rehydrates from the server — this is what makes the wizard resumable. */
  const refresh = useCallback(async () => {
    try {
      const [connectionRes, discoveryRes] = await Promise.all([
        api("/api/v1/connections/odoo", workspaceId),
        api("/api/v1/discovery", workspaceId),
      ]);
      if (connectionRes.ok) {
        const body = await connectionRes.json();
        setConnection(body.connection ?? null);
        if (body.connection) {
          setForm((f) => ({
            // The API key is never returned, so the field stays empty and the
            // customer is told a credential is already stored.
            ...f,
            baseUrl: body.connection.baseUrl,
            database: body.connection.database,
            login: body.connection.login,
          }));
        }
      }
      if (discoveryRes.ok) {
        const body = await discoveryRes.json();
        setSnapshot(body.snapshot ?? null);
        if (body.snapshot) setState("snapshot_ready");
        else if (body.latestRun?.status === "running") setState("discovering");
        else if (body.latestRun?.status === "failed") setState("failed");
      }
    } catch {
      // A refresh failure is not a wizard failure; the customer keeps what they
      // can see and can retry.
    } finally {
      setLoaded(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a scan is running so progress is visible without a reload.
  useEffect(() => {
    if (state !== "discovering") return;
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [state, refresh]);

  const stepIndex = stepIndexFor(state);

  async function saveConnection() {
    setBusy("saving");
    setError(null);
    try {
      const res = await api("/api/v1/connections/odoo", workspaceId, {
        method: "POST",
        body: JSON.stringify(form),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? (ar ? "تعذر حفظ الاتصال." : "Could not save the connection."));
        return;
      }
      setConnection(body.connection);
      setState("connection_pending");
      // The server decides whether the previous verdict survived the save — it
      // does only for an unreadable credential this save has not replaced.
      // Follow that rather than leaving a banner it has just dropped, or hiding
      // one it deliberately kept.
      if (!body.connection?.lastTestState) setTest(null);
      // The key is out of the browser's hands the moment it is stored.
      setForm((f) => ({ ...f, apiKey: "" }));
    } catch {
      setError(ar ? "تعذر الاتصال بالخادم." : "Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy("testing");
    setError(null);
    try {
      const res = await api("/api/v1/connections/odoo/test-connection", workspaceId, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? (ar ? "فشل اختبار الاتصال." : "The connection test failed."));
        return;
      }
      setTest(body.result);
      setState(
        body.result.state === "success"
          ? "validating"
          : body.result.state === "access_denied"
            ? "permission_failed"
            : "failed",
      );
      await refresh();
    } catch {
      setError(ar ? "تعذر الاتصال بالخادم." : "Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function runDiscovery() {
    setBusy("discovering");
    setError(null);
    try {
      const res = await api("/api/v1/discovery", workspaceId, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? (ar ? "تعذر بدء القراءة." : "Could not start discovery."));
        return;
      }
      setState("discovering");
    } catch {
      setError(ar ? "تعذر الاتصال بالخادم." : "Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  const readable = useMemo(() => test?.probes.filter((p) => p.canRead).length ?? 0, [test]);
  const gaps = useMemo(() => test?.probes.filter((p) => p.gap) ?? [], [test]);

  // Falls back to the persisted state so the recovery instruction survives a
  // reload, like every other piece of wizard state.
  const credentialUnreadable =
    (test?.state ?? connection?.lastTestState) === "credential_unreadable";

  if (!loaded) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span>{ar ? "جاري التحميل…" : "Loading…"}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6" dir={ar ? "rtl" : "ltr"}>
      <StepRail current={stepIndex} ar={ar} />

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p>{error}</p>
        </div>
      )}

      {/* Step 1 — connection */}
      <section className="rounded-xl border border-border bg-card p-5">
        <header className="mb-4 flex items-center gap-2">
          <Database className="size-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">
            {ar ? "بيانات الاتصال بأودو" : "Odoo connection details"}
          </h2>
        </header>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={ar ? "رابط أودو" : "Odoo URL"}
            hint={ar ? "لازم يبدأ بـ https" : "Must start with https"}
            value={form.baseUrl}
            onChange={(v) => setForm({ ...form, baseUrl: v })}
            placeholder="https://company.odoo.com"
            ltr
          />
          <Field
            label={ar ? "اسم قاعدة البيانات" : "Database name"}
            value={form.database}
            onChange={(v) => setForm({ ...form, database: v })}
            placeholder="company-production"
            ltr
          />
          <Field
            label={ar ? "اسم المستخدم" : "Login"}
            value={form.login}
            onChange={(v) => setForm({ ...form, login: v })}
            placeholder="analytics@company.com"
            ltr
          />
          <Field
            label={ar ? "مفتاح الـ API" : "API key"}
            hint={
              credentialUnreadable
                ? ar
                  ? "المفتاح المحفوظ بقى مش مقروء. اكتبه تاني واحفظ عشان الاتصال يرجع يشتغل."
                  : "The stored key is no longer readable. Enter it again and save to restore the connection."
                : connection?.hasSecret
                  ? ar
                    ? "محفوظ ومشفّر. اكتب مفتاحًا جديدًا فقط لو عايز تغيّره."
                    : "Stored and encrypted. Enter a new key only to replace it."
                  : ar
                    ? "بيتحفظ مشفّرًا ومش بيرجع للمتصفح تاني أبدًا."
                    : "Stored encrypted and never returned to the browser."
            }
            value={form.apiKey}
            onChange={(v) => setForm({ ...form, apiKey: v })}
            placeholder={connection?.hasSecret ? "••••••••••••" : ""}
            type="password"
            ltr
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={saveConnection}
            // An empty key is allowed once one is stored: the API keeps the
            // existing credential, so correcting a URL or a login costs nothing.
            // The exception is an unreadable credential — saving without a key
            // there would reuse the ciphertext that is precisely the problem, so
            // the field is required until it is replaced.
            disabled={
              busy !== null ||
              !form.baseUrl ||
              !form.database ||
              !form.login ||
              (!form.apiKey && (!connection?.hasSecret || credentialUnreadable))
            }
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy === "saving" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {ar ? "حفظ الاتصال" : "Save connection"}
          </button>

          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3" />
            {ar
              ? "استخدم مستخدم أودو للقراءة فقط. المنصة لا تكتب في أودو إطلاقًا."
              : "Use a read-only Odoo user. The platform never writes to Odoo."}
          </p>
        </div>
      </section>

      {/* Step 2 — permissions */}
      {connection && (
        <section className="rounded-xl border border-border bg-card p-5">
          <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Lock className="size-4 text-muted-foreground" />
              <h2 className="text-base font-semibold">
                {ar ? "التحقق من الصلاحيات" : "Permission check"}
              </h2>
            </div>
            <button
              type="button"
              onClick={runTest}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {busy === "testing" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {ar ? "اختبار الاتصال" : "Test connection"}
            </button>
          </header>

          {test ? (
            <div className="space-y-4">
              <StateBanner state={test.state} message={ar ? test.message.ar : test.message.en} />

              {test.serverVersion && (
                <p className="text-sm text-muted-foreground">
                  {ar ? "إصدار أودو:" : "Odoo version:"}{" "}
                  <span dir="ltr" className="font-mono">
                    {test.serverVersion}
                  </span>
                </p>
              )}

              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-start text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="p-2 text-start">{ar ? "الموديل" : "Model"}</th>
                      <th className="p-2 text-start">{ar ? "القراءة" : "Read"}</th>
                      <th className="p-2 text-start">{ar ? "الحقول" : "Fields"}</th>
                      <th className="p-2 text-start">{ar ? "السجلات" : "Records"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {test.probes.map((probe) => (
                      <tr key={probe.model} className="border-t border-border/60">
                        <td className="p-2 font-mono text-xs" dir="ltr">
                          {probe.model}
                        </td>
                        <td className="p-2">
                          {probe.canRead ? (
                            <CheckCircle2 className="size-4 text-emerald-500" />
                          ) : (
                            <XCircle className="size-4 text-destructive" />
                          )}
                        </td>
                        {/* An em dash, never 0 — unavailable is not zero. */}
                        <td className="p-2 tabular-nums">{probe.fieldCount ?? "—"}</td>
                        <td className="p-2 tabular-nums">
                          {probe.recordCount === null ? "—" : probe.recordCount.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {gaps.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <p className="mb-1 flex items-center gap-2 font-medium">
                    <ShieldAlert className="size-4" />
                    {ar
                      ? `${gaps.length} موديل بدون صلاحية قراءة`
                      : `${gaps.length} model(s) without read permission`}
                  </p>
                  <p className="text-muted-foreground">
                    {ar
                      ? "التحليلات هتشتغل على الموديلات المتاحة، والباقي هيتسجّل كنقص صلاحيات لحد ما يتظبط."
                      : "Analytics will run on the available models; the rest are recorded as permission gaps until granted."}
                  </p>
                </div>
              )}

              {readable > 0 && (
                <button
                  type="button"
                  onClick={runDiscovery}
                  disabled={busy !== null || state === "discovering"}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {state === "discovering" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {ar ? "ابدأ قراءة بنية البيانات" : "Start structure discovery"}
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {ar
                ? "اضغط «اختبار الاتصال» للتأكد من البيانات وصلاحيات القراءة لكل موديل."
                : "Run the test to verify the credentials and per-model read permission."}
            </p>
          )}
        </section>
      )}

      {/* Steps 3 and 4 — discovery and result */}
      {(state === "discovering" || snapshot) && (
        <section className="rounded-xl border border-border bg-card p-5">
          <header className="mb-4 flex items-center gap-2">
            <RefreshCw className="size-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">
              {ar ? "بنية البيانات المكتشفة" : "Discovered data structure"}
            </h2>
          </header>

          {state === "discovering" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {ar
                ? "جاري القراءة… العملية بتكمل من آخر نقطة لو حصل انقطاع."
                : "Reading… the scan resumes from its last checkpoint if interrupted."}
            </p>
          )}

          {snapshot && (
            <div className="space-y-4">
              {/* Last-good: shown even when the newest run failed. */}
              {state === "failed" && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  {ar
                    ? "آخر محاولة قراءة فشلت. المعروض تحت هو آخر نسخة ناجحة، مش بيانات جديدة."
                    : "The most recent scan failed. What is shown below is the last successful snapshot, not fresh data."}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label={ar ? "الموديلات" : "Models"} value={snapshot.modelCount} />
                <Stat label={ar ? "الحقول" : "Fields"} value={snapshot.fieldCount} />
                <Stat label={ar ? "العلاقات" : "Relations"} value={snapshot.relationCount} />
                <Stat
                  label={ar ? "نقص الصلاحيات" : "Permission gaps"}
                  value={snapshot.permissionGaps.length}
                />
              </div>

              <p className="text-xs text-muted-foreground">
                {ar ? "بصمة النسخة:" : "Snapshot hash:"}{" "}
                <span dir="ltr" className="font-mono">
                  {snapshot.contentHash.slice(0, 16)}…
                </span>
                {" · "}
                {ar
                  ? "نفس البصمة معناها إن بنية أودو ما اتغيرتش."
                  : "An identical hash means the Odoo structure has not changed."}
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function StepRail({ current, ar }: { current: number; ar: boolean }) {
  return (
    <ol className="flex flex-wrap gap-2">
      {STEPS.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const Icon = done ? CheckCircle2 : active ? step.icon : CircleDashed;
        return (
          <li
            key={step.key}
            className={[
              "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
              done
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : active
                  ? "border-primary/50 bg-primary/10"
                  : "border-border text-muted-foreground",
            ].join(" ")}
          >
            <Icon className="size-4" />
            {ar ? step.ar : step.en}
          </li>
        );
      })}
    </ol>
  );
}

function StateBanner({ state, message }: { state: string; message: string }) {
  const tone =
    state === "success"
      ? "border-emerald-500/40 bg-emerald-500/10"
      : state === "access_denied"
        ? "border-amber-500/40 bg-amber-500/10"
        : "border-destructive/40 bg-destructive/10";
  const Icon =
    state === "success"
      ? CheckCircle2
      : state === "access_denied"
        ? ShieldAlert
        : state === "credential_unreadable"
          ? KeyRound
          : XCircle;
  return (
    <div className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${tone}`}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <p>{message}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</p>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = "text",
  ltr,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  ltr?: boolean;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        // Technical values stay LTR inside an RTL form.
        dir={ltr ? "ltr" : undefined}
        autoComplete={type === "password" ? "new-password" : "off"}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
      />
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
