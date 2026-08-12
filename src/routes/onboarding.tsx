import { createFileRoute } from "@tanstack/react-router";
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
import { useI18n, Ltr, formatNumber, DASH } from "@/lib/i18n";
import { can, useSession, workspaceFetch } from "@/lib/session";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Field,
  Notice,
  PageHeader,
  Td,
  Th,
} from "@/components/ui/primitives";

export const Route = createFileRoute("/onboarding")({ component: OnboardingPage });

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
}

interface Connection {
  id: string;
  baseUrl: string;
  database: string;
  login: string;
  hasSecret: boolean;
  status: string;
  odooVersion: string | null;
}

interface SnapshotSummary {
  id: string;
  contentHash: string;
  modelCount: number;
  fieldCount: number;
  relationCount: number;
  permissionGaps: Array<{ model: string; reason: string }>;
}

const STEPS = [
  { key: "onboarding_step_connection", icon: Database },
  { key: "onboarding_step_permissions", icon: Lock },
  { key: "onboarding_step_discovery", icon: RefreshCw },
  { key: "onboarding_step_mapping", icon: CheckCircle2 },
] as const;

function stepIndexFor(state: string): number {
  switch (state) {
    case "draft":
    case "connection_pending":
      return 0;
    case "validating":
    case "permission_failed":
    case "failed":
      return 1;
    case "discovering":
      return 2;
    default:
      return 3;
  }
}

function OnboardingPage() {
  const { t, lang } = useI18n();
  const ar = lang === "ar";
  const { workspace, refresh: refreshSession } = useSession();

  const [connection, setConnection] = useState<Connection | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotSummary | null>(null);
  const [runFailed, setRunFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<null | "saving" | "testing" | "discovering">(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ baseUrl: "", database: "", login: "", apiKey: "" });

  const workspaceId = workspace?.id ?? null;
  const mayWrite = can(workspace, "connection.write");

  /** Rehydrates from the server — this is what makes the wizard resumable. */
  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [connectionRes, discoveryRes] = await Promise.all([
        workspaceFetch(workspaceId, "/api/v1/connections/odoo"),
        workspaceFetch(workspaceId, "/api/v1/discovery"),
      ]);

      if (connectionRes.ok) {
        const body = await connectionRes.json();
        setConnection(body.connection ?? null);
        if (body.connection) {
          setForm((f) => ({
            ...f,
            baseUrl: body.connection.baseUrl,
            database: body.connection.database,
            login: body.connection.login,
            // The key is never returned, so the field stays empty.
            apiKey: "",
          }));
        }
      }

      if (discoveryRes.ok) {
        const body = await discoveryRes.json();
        setSnapshot(body.snapshot ?? null);
        setRunning(body.latestRun?.status === "running");
        setRunFailed(body.latestRun?.status === "failed");
      }
    } catch {
      // A refresh failure is not a wizard failure: keep what is on screen.
    } finally {
      setLoaded(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a scan runs so progress is visible without a reload.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const readable = useMemo(() => test?.probes.filter((p) => p.canRead).length ?? 0, [test]);
  const gaps = useMemo(() => test?.probes.filter((p) => p.gap) ?? [], [test]);

  async function call(
    kind: "saving" | "testing" | "discovering",
    path: string,
    init: RequestInit,
    onSuccess: (body: Record<string, unknown>) => void,
  ) {
    if (!workspaceId) return;
    setBusy(kind);
    setError(null);
    try {
      const response = await workspaceFetch(workspaceId, path, init);
      const body = await response.json();
      if (!response.ok) {
        if (body.reason === "credential_requires_reentry") {
          setError(
            ar
              ? "مفتاح أودو المحفوظ مرتبط بسجل تشفير قديم. اكتب API key من جديد واضغط حفظ مرة واحدة."
              : "The saved Odoo key belongs to an older encryption record. Enter the API key again and press Save once.",
          );
        } else {
          setError(String(body.error ?? (ar ? "حصلت مشكلة." : "Something went wrong.")));
        }
        return;
      }
      onSuccess(body);
      await refresh();
      await refreshSession();
    } catch {
      setError(ar ? "تعذر الاتصال بالخادم." : "Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  if (!workspace) {
    return <Notice tone="warning">{t("workspace_none")}</Notice>;
  }

  if (!loaded) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-8 text-text-muted">
        <Loader2 className="size-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  const stepIndex = stepIndexFor(workspace.onboardingState);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("onboarding_title")}
        subtitle={
          ar
            ? "اربط قاعدة بيانات أودو للقراءة فقط، اتأكد من الصلاحيات، واقرأ بنية بياناتك — من غير ما تكتب أي كود."
            : "Connect a read-only Odoo database, verify permissions, and read your data structure — without writing any code."
        }
      />

      <ol className="flex flex-wrap gap-2">
        {STEPS.map((step, index) => {
          const done = index < stepIndex;
          const active = index === stepIndex;
          const Icon = done ? CheckCircle2 : active ? step.icon : CircleDashed;
          return (
            <li
              key={step.key}
              className={[
                "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
                done
                  ? "border-success/40 bg-success-soft text-success"
                  : active
                    ? "border-brand/50 bg-brand-soft text-brand-ink"
                    : "border-border text-text-muted",
              ].join(" ")}
            >
              <Icon className="size-4" />
              {t(step.key)}
            </li>
          );
        })}
      </ol>

      {error && (
        <Notice tone="danger" icon={<AlertTriangle className="size-4" />}>
          {error}
        </Notice>
      )}

      {!mayWrite && (
        <Notice tone="warning">
          {ar
            ? "دورك في مساحة العمل دي مسموح له بالعرض فقط."
            : "Your role in this workspace is read-only."}
        </Notice>
      )}

      {/* Step 1 — connection */}
      <Card>
        <CardHeader
          icon={<Database className="size-4" />}
          title={ar ? "بيانات الاتصال بأودو" : "Odoo connection details"}
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t("odoo_url")}
              hint={ar ? "لازم يبدأ بـ https" : "Must start with https"}
              placeholder="https://company.odoo.com"
              ltr
              disabled={!mayWrite}
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
            <Field
              label={t("odoo_database")}
              placeholder="company-production"
              ltr
              disabled={!mayWrite}
              value={form.database}
              onChange={(e) => setForm({ ...form, database: e.target.value })}
            />
            <Field
              label={t("odoo_login")}
              placeholder="analytics@company.com"
              ltr
              disabled={!mayWrite}
              value={form.login}
              onChange={(e) => setForm({ ...form, login: e.target.value })}
            />
            <Field
              label={t("odoo_api_key")}
              type="password"
              ltr
              disabled={!mayWrite}
              placeholder={connection?.hasSecret ? "••••••••••••" : ""}
              hint={connection?.hasSecret ? t("odoo_key_stored") : t("odoo_key_new")}
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={
                !mayWrite ||
                busy !== null ||
                !form.baseUrl ||
                !form.database ||
                !form.login ||
                !form.apiKey
              }
              onClick={() =>
                call(
                  "saving",
                  "/api/v1/connections/odoo",
                  {
                    method: "POST",
                    body: JSON.stringify(form),
                  },
                  () => setForm((f) => ({ ...f, apiKey: "" })),
                )
              }
            >
              {busy === "saving" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              {t("save")}
            </Button>
            <p className="flex items-center gap-1.5 text-xs text-text-muted">
              <Lock className="size-3" />
              {t("odoo_read_only_hint")}
            </p>
          </div>
        </CardBody>
      </Card>

      {/* Step 2 — permissions */}
      {connection && (
        <Card>
          <CardHeader
            icon={<Lock className="size-4" />}
            title={t("onboarding_step_permissions")}
            actions={
              <Button
                variant="secondary"
                size="sm"
                disabled={!can(workspace, "connection.test") || busy !== null}
                onClick={() =>
                  call(
                    "testing",
                    "/api/v1/connections/odoo/test-connection",
                    { method: "POST" },
                    (body) => setTest(body.result as ConnectionTestResult),
                  )
                }
              >
                {busy === "testing" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {t("test_connection")}
              </Button>
            }
          />
          <CardBody className="space-y-4">
            {test ? (
              <>
                <Notice
                  tone={
                    test.state === "success"
                      ? "success"
                      : test.state === "access_denied"
                        ? "warning"
                        : "danger"
                  }
                  icon={
                    test.state === "success" ? (
                      <CheckCircle2 className="size-4" />
                    ) : test.state === "access_denied" ? (
                      <ShieldAlert className="size-4" />
                    ) : (
                      <XCircle className="size-4" />
                    )
                  }
                >
                  {ar ? test.message.ar : test.message.en}
                </Notice>

                {test.serverVersion && (
                  <p className="text-sm text-text-muted">
                    {ar ? "إصدار أودو:" : "Odoo version:"}{" "}
                    <Ltr>
                      <code className="font-mono text-xs">{test.serverVersion}</code>
                    </Ltr>
                  </p>
                )}

                <DataTable>
                  <thead>
                    <tr>
                      <Th>{ar ? "الموديل" : "Model"}</Th>
                      <Th>{ar ? "القراءة" : "Read"}</Th>
                      <Th>{ar ? "الحقول" : "Fields"}</Th>
                      <Th>{ar ? "السجلات" : "Records"}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {test.probes.map((probe) => (
                      <tr key={probe.model}>
                        <Td className="font-mono text-xs">
                          <Ltr>{probe.model}</Ltr>
                        </Td>
                        <Td>
                          {probe.canRead ? (
                            <CheckCircle2 className="size-4 text-success" />
                          ) : (
                            <XCircle className="size-4 text-danger" />
                          )}
                        </Td>
                        {/* An em dash, never 0 — unavailable is not zero. */}
                        <Td className="tabular-nums">
                          {probe.fieldCount === null ? DASH : formatNumber(probe.fieldCount, lang)}
                        </Td>
                        <Td className="tabular-nums">
                          {probe.recordCount === null
                            ? DASH
                            : formatNumber(probe.recordCount, lang)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>

                {gaps.length > 0 && (
                  <Notice
                    tone="warning"
                    icon={<ShieldAlert className="size-4" />}
                    title={
                      ar
                        ? `${gaps.length} موديل بدون صلاحية قراءة`
                        : `${gaps.length} model(s) without read permission`
                    }
                  >
                    {ar
                      ? "التحليلات هتشتغل على الموديلات المتاحة، والباقي هيتسجّل كنقص صلاحيات لحد ما يتظبط."
                      : "Analytics will run on the available models; the rest are recorded as permission gaps until granted."}
                  </Notice>
                )}

                {readable > 0 && (
                  <Button
                    disabled={!can(workspace, "discovery.run") || busy !== null || running}
                    onClick={() =>
                      call("discovering", "/api/v1/discovery", { method: "POST" }, () =>
                        setRunning(true),
                      )
                    }
                  >
                    {running ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    {t("start_discovery")}
                  </Button>
                )}
              </>
            ) : (
              <p className="text-sm text-text-muted">
                {ar
                  ? "اضغط «اختبار الاتصال» للتأكد من البيانات وصلاحيات القراءة لكل موديل."
                  : "Run the test to verify the credentials and per-model read permission."}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {/* Steps 3 and 4 — discovery result */}
      {(running || snapshot) && (
        <Card>
          <CardHeader
            icon={<RefreshCw className="size-4" />}
            title={ar ? "بنية البيانات المكتشفة" : "Discovered data structure"}
          />
          <CardBody className="space-y-4">
            {running && (
              <p className="flex items-center gap-2 text-sm text-text-muted">
                <Loader2 className="size-4 animate-spin" />
                {ar
                  ? "جاري القراءة… العملية بتكمل من آخر نقطة لو حصل انقطاع."
                  : "Reading… the scan resumes from its last checkpoint if interrupted."}
              </p>
            )}

            {snapshot && (
              <>
                {/* Last-good: shown even when the newest run failed. */}
                {runFailed && (
                  <Notice tone="warning" title={t("last_good")}>
                    {ar
                      ? "آخر محاولة قراءة فشلت. المعروض تحت هو آخر نسخة ناجحة، مش بيانات جديدة."
                      : "The most recent scan failed. What is shown below is the last successful snapshot, not fresh data."}
                  </Notice>
                )}

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label={ar ? "الموديلات" : "Models"} value={snapshot.modelCount} />
                  <Stat label={ar ? "الحقول" : "Fields"} value={snapshot.fieldCount} />
                  <Stat label={ar ? "العلاقات" : "Relations"} value={snapshot.relationCount} />
                  <Stat
                    label={ar ? "نقص الصلاحيات" : "Permission gaps"}
                    value={snapshot.permissionGaps.length}
                    tone={snapshot.permissionGaps.length ? "warning" : "neutral"}
                  />
                </div>

                <p className="text-xs text-text-muted">
                  {ar ? "بصمة النسخة:" : "Snapshot hash:"}{" "}
                  <Ltr>
                    <code className="font-mono">{snapshot.contentHash.slice(0, 16)}…</code>
                  </Ltr>{" "}
                  ·{" "}
                  {ar
                    ? "نفس البصمة معناها إن بنية أودو ما اتغيرتش."
                    : "An identical hash means the Odoo structure has not changed."}
                </p>
              </>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "warning";
}) {
  const { lang } = useI18n();
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-0.5 flex items-center gap-2 text-lg font-semibold tabular-nums">
        {formatNumber(value, lang)}
        {tone === "warning" && value > 0 && <Badge tone="warning">!</Badge>}
      </p>
    </div>
  );
}
