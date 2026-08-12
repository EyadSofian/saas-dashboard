import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
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
  lastTestState: string | null;
  lastTestedAt: string | null;
}

interface DiscoveryJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  attempts: number;
  max_attempts: number;
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
  const navigate = useNavigate();
  const pendingDiscoveryJobId = useRef<string | null>(null);

  const [connection, setConnection] = useState<Connection | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotSummary | null>(null);
  const [runFailed, setRunFailed] = useState(false);
  const [job, setJob] = useState<DiscoveryJob | null>(null);
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
        const latestJob = (body.latestJob ?? null) as DiscoveryJob | null;
        const jobActive = latestJob?.status === "queued" || latestJob?.status === "running";
        setJob(latestJob);
        setSnapshot(body.snapshot ?? null);
        setRunning(jobActive || body.latestRun?.status === "running");
        setRunFailed(
          !body.snapshot && (latestJob?.status === "failed" || body.latestRun?.status === "failed"),
        );
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

  // A scan started from this page should finish the wizard journey, not leave
  // the customer hunting for another button after the snapshot is ready. Tie
  // navigation to that exact job: an older ready snapshot must not make a new
  // scan navigate before it actually succeeds.
  useEffect(() => {
    const pendingId = pendingDiscoveryJobId.current;
    if (!pendingId || job?.id !== pendingId) return;

    if (job.status === "succeeded" && snapshot) {
      pendingDiscoveryJobId.current = null;
      void navigate({ to: "/mapping" });
    }

    if (job.status === "failed" || job.status === "cancelled") {
      pendingDiscoveryJobId.current = null;
    }
  }, [job, navigate, snapshot]);

  const discoveryAccepted = useCallback((body: Record<string, unknown>) => {
    const jobId = typeof body.jobId === "string" ? body.jobId : null;
    pendingDiscoveryJobId.current = jobId;
    setRunning(true);
  }, []);

  const readable = useMemo(() => test?.probes.filter((p) => p.canRead).length ?? 0, [test]);
  const gaps = useMemo(() => test?.probes.filter((p) => p.gap) ?? [], [test]);
  const previouslyVerified = connection?.lastTestState === "success";
  const mayDiscover = readable > 0 || previouslyVerified || Boolean(snapshot);
  const Arrow = ar ? ArrowLeft : ArrowRight;

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

      {previouslyVerified && !snapshot && !running && (
        <Notice
          tone={runFailed ? "warning" : "brand"}
          icon={runFailed ? <AlertTriangle className="size-4" /> : <RefreshCw className="size-4" />}
          title={
            runFailed
              ? ar
                ? "قراءة البنية محتاجة إعادة محاولة"
                : "Structure discovery needs another attempt"
              : ar
                ? "الاتصال جاهز — اقرأ بنية أودو"
                : "Connection ready — discover your Odoo structure"
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              {ar
                ? "اضغط مرة واحدة؛ هنقرأ أسماء الموديلات والحقول وبعدها ننقلك لمراجعة الخريطة."
                : "Click once; we will read model and field names, then take you to mapping review."}
            </p>
            <Button
              disabled={!can(workspace, "discovery.run") || busy !== null}
              onClick={() =>
                call("discovering", "/api/v1/discovery", { method: "POST" }, discoveryAccepted)
              }
            >
              <RefreshCw className="size-4" />
              {runFailed ? (ar ? "أعد المحاولة" : "Retry discovery") : t("start_discovery")}
            </Button>
          </div>
        </Notice>
      )}

      {snapshot && !running && (
        <Notice
          tone="success"
          icon={<CheckCircle2 className="size-4" />}
          title={ar ? "قراءة بنية أودو اكتملت" : "Odoo discovery is complete"}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              {ar
                ? "كل حاجة جاهزة. كمل لمراجعة معاني الحقول واعتمادها."
                : "Everything is ready. Continue to review and approve the field meanings."}
            </p>
            <Link to="/mapping">
              <Button>
                {ar ? "كمل لمراجعة الخريطة" : "Continue to mapping"}
                <Arrow className="size-4" />
              </Button>
            </Link>
          </div>
        </Notice>
      )}

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
              // An empty key is allowed once one is stored: the API keeps the
              // existing credential, so correcting a URL, a database name or a
              // login costs nothing. This is what the stored-key hint above has
              // always promised.
              disabled={
                !mayWrite ||
                busy !== null ||
                !form.baseUrl ||
                !form.database ||
                !form.login ||
                (!form.apiKey && !connection?.hasSecret)
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

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Stat label={ar ? "موديلات متاحة" : "Readable models"} value={readable} />
                  <Stat
                    label={ar ? "إجمالي الموديلات" : "Models checked"}
                    value={test.probes.length}
                  />
                  <Stat
                    label={ar ? "نقص الصلاحيات" : "Permission gaps"}
                    value={gaps.length}
                    tone={gaps.length ? "warning" : "neutral"}
                  />
                </div>

                {readable > 0 && (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft p-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-brand-ink">
                        {ar
                          ? "الاتصال جاهز لقراءة البنية"
                          : "The connection is ready for discovery"}
                      </p>
                      <p className="text-xs text-text-muted">
                        {ar
                          ? "هنقرأ أسماء الموديلات والحقول فقط — من غير بيانات عملاء أو مبيعات."
                          : "We read model and field names only — never customer or sales records."}
                      </p>
                    </div>
                    <Button
                      disabled={!can(workspace, "discovery.run") || busy !== null || running}
                      onClick={() =>
                        call(
                          "discovering",
                          "/api/v1/discovery",
                          { method: "POST" },
                          discoveryAccepted,
                        )
                      }
                    >
                      {running ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                      {running
                        ? job?.status === "queued"
                          ? ar
                            ? "في انتظار البدء"
                            : "Waiting to start"
                          : ar
                            ? "جاري القراءة"
                            : "Reading structure"
                        : t("start_discovery")}
                    </Button>
                  </div>
                )}

                <details className="group rounded-lg border border-border">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 text-sm font-medium">
                    <span>{ar ? "عرض تفاصيل الصلاحيات" : "Show permission details"}</span>
                    <ChevronDown className="size-4 text-text-muted transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="border-t border-border p-3">
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
                            <Td className="tabular-nums">
                              {probe.fieldCount === null
                                ? DASH
                                : formatNumber(probe.fieldCount, lang)}
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
                  </div>
                </details>

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
              </>
            ) : previouslyVerified ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-success/30 bg-success-soft p-3">
                <CheckCircle2 className="size-5 text-success" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {ar ? "الاتصال اتراجع بنجاح" : "Connection already verified"}
                  </p>
                  <p className="text-xs text-text-muted">
                    {ar
                      ? "مش محتاج تعيد الاختبار بعد كل Refresh."
                      : "You do not need to repeat the test after every refresh."}
                  </p>
                </div>
                {mayDiscover && (
                  <Button
                    disabled={!can(workspace, "discovery.run") || busy !== null || running}
                    onClick={() =>
                      call(
                        "discovering",
                        "/api/v1/discovery",
                        { method: "POST" },
                        discoveryAccepted,
                      )
                    }
                  >
                    {running ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    {running ? (ar ? "جاري القراءة" : "Reading structure") : t("start_discovery")}
                  </Button>
                )}
              </div>
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
              <Notice
                tone="brand"
                icon={<Loader2 className="size-4 animate-spin" />}
                title={
                  job?.status === "queued"
                    ? ar
                      ? "القراءة في الطابور"
                      : "Discovery is queued"
                    : ar
                      ? "جاري قراءة بنية أودو"
                      : "Reading the Odoo structure"
                }
              >
                {job?.status === "queued" && job.error
                  ? ar
                    ? `حصل انقطاع مؤقت والمحاولة هتتكرر تلقائيًا (${job.attempts}/${job.max_attempts}).`
                    : `A temporary interruption occurred; the job will retry automatically (${job.attempts}/${job.max_attempts}).`
                  : ar
                    ? "تقدر تسيب الصفحة وترجع لها — العملية بتكمل وبتحفظ آخر نقطة وصلت لها."
                    : "You can leave this page and come back — the job keeps running and saves its progress."}
              </Notice>
            )}

            {runFailed && !running && !snapshot && (
              <Notice
                tone="danger"
                icon={<XCircle className="size-4" />}
                title={ar ? "القراءة ما اكتملتش" : "Discovery did not finish"}
              >
                <p>
                  {ar
                    ? "آخر محاولة فشلت، ومفيش نسخة سابقة نعرضها."
                    : "The latest attempt failed and there is no previous snapshot to show."}
                </p>
                <Button
                  className="mt-3"
                  size="sm"
                  disabled={!can(workspace, "discovery.run") || busy !== null}
                  onClick={() =>
                    call("discovering", "/api/v1/discovery", { method: "POST" }, discoveryAccepted)
                  }
                >
                  <RefreshCw className="size-4" />
                  {ar ? "حاول تاني" : "Try again"}
                </Button>
              </Notice>
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

                {!running && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/30 bg-success-soft p-3">
                    <div>
                      <p className="font-medium text-success">
                        {runFailed
                          ? ar
                            ? "آخر نسخة ناجحة لسه متاحة"
                            : "The last good snapshot is still available"
                          : ar
                            ? "قراءة البنية اكتملت"
                            : "Structure discovery is complete"}
                      </p>
                      <p className="text-xs text-text-muted">
                        {ar
                          ? "الخطوة الجاية: راجع معاني الحقول واعتمدها."
                          : "Next: review and approve what each field means."}
                      </p>
                    </div>
                    <Link to="/mapping">
                      <Button>
                        {ar ? "راجع الخريطة" : "Review mapping"}
                        <Arrow className="size-4" />
                      </Button>
                    </Link>
                    {runFailed && (
                      <Button
                        variant="secondary"
                        disabled={!can(workspace, "discovery.run") || busy !== null}
                        onClick={() =>
                          call(
                            "discovering",
                            "/api/v1/discovery",
                            { method: "POST" },
                            discoveryAccepted,
                          )
                        }
                      >
                        <RefreshCw className="size-4" />
                        {ar ? "أعد القراءة" : "Retry discovery"}
                      </Button>
                    )}
                  </div>
                )}
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
