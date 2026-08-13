import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Info, Loader2, PencilLine, RefreshCw, Undo2 } from "lucide-react";
import { DASH, formatCurrency, formatNumber, useI18n } from "@/lib/i18n";
import { can, useSession, workspaceFetch } from "@/lib/session";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Notice,
  PageHeader,
  SelectField,
  Skeleton,
  Td,
  Th,
} from "@/components/ui/primitives";
import type { DashboardDefinition, Widget } from "@/platform/dashboards/templates";
import { Builder, type BuilderIssue, type MetricOption } from "@/components/dashboards/Builder";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboards")({ component: DashboardsPage });

interface MetricValue {
  metricKey: string;
  value: number | null;
  isAvailable: boolean;
  unavailableReason?: string;
  unit: "count" | "currency" | "percent" | "duration" | "number";
  dimensions?: Record<string, string | null>;
  datePolicy: string | null;
  metricVersion: number;
  generationId: string | null;
  formula: { ar: string; en: string };
}

/** Presets convert to a half-open range before they reach the server. */
function presetRange(preset: string): { from: string; to: string } {
  const now = new Date();
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  // `to` is exclusive: tomorrow, so today is included exactly once.
  const tomorrow = new Date(now.getTime() + 86_400_000);

  switch (preset) {
    case "month":
      return { from: iso(startOfMonth), to: iso(tomorrow) };
    case "last30":
      return { from: iso(new Date(now.getTime() - 30 * 86_400_000)), to: iso(tomorrow) };
    default:
      return { from: iso(startOfYear), to: iso(tomorrow) };
  }
}

function DashboardsPage() {
  const { lang, t } = useI18n();
  const ar = lang === "ar";
  const { workspace } = useSession();
  const workspaceId = workspace?.id ?? null;

  const [dashboards, setDashboards] = useState<
    Array<{
      key: string;
      title: { ar: string; en: string };
      status: string;
      version: number;
      definition: DashboardDefinition;
    }>
  >([]);
  const [metrics, setMetrics] = useState<MetricOption[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardDefinition>({ version: 1, widgets: [] });
  const [issues, setIssues] = useState<BuilderIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [preset, setPreset] = useState("year");
  const [values, setValues] = useState<MetricValue[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [generation, setGeneration] = useState<{ published_at?: string } | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  // Why the last refresh failed, from the run or the job that carried it. The
  // API has always returned this; the page used to read only the status beside
  // it and drop the one field that says what went wrong.
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  // The newest job says `running` but no worker holds its lease.
  const [syncStalled, setSyncStalled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const template = useMemo(
    () => dashboards.find((d) => d.key === selectedKey) ?? dashboards[0] ?? null,
    [dashboards, selectedKey],
  );

  const metricKeys = useMemo(
    () => [...new Set((template?.definition.widgets ?? []).flatMap((w) => w.metricKeys))],
    [template],
  );
  // The signature stays stable when a fetch returns equivalent dashboard
  // objects, preventing the loading effect from calling itself forever.
  const metricKeySignature = JSON.stringify(metricKeys);
  const queryMetricKeys = useMemo(
    () => JSON.parse(metricKeySignature) as string[],
    [metricKeySignature],
  );

  useEffect(() => {
    setSelectedKey("");
    setValues([]);
  }, [workspaceId]);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [dashboardsRes, syncRes] = await Promise.all([
        workspaceFetch(workspaceId, "/api/v1/dashboards"),
        workspaceFetch(workspaceId, "/api/v1/sync"),
      ]);

      if (dashboardsRes.ok) {
        const body = await dashboardsRes.json();
        setDashboards(body.dashboards ?? []);
        setMetrics(body.metrics ?? []);
        setSelectedKey((current) => current || (body.dashboards?.[0]?.key ?? ""));
      } else {
        setError(ar ? "تعذر تحميل اللوحات." : "Could not load dashboards.");
      }

      // Metric values are fetched separately because the dashboard list decides
      // which keys to ask for.
      if (queryMetricKeys.length) {
        const metricsRes = await workspaceFetch(workspaceId, "/api/v1/metrics/query", {
          method: "POST",
          body: JSON.stringify({ metricKeys: queryMetricKeys, dateRange: presetRange(preset) }),
        });
        if (metricsRes.ok) setValues((await metricsRes.json()).values ?? []);
      } else {
        setValues([]);
      }
      if (syncRes.ok) {
        const body = await syncRes.json();
        setGeneration(body.generation ?? null);
        // The job is the outer truth: a run row only exists once the sync got
        // far enough to create one, and the failures that strand a first-time
        // customer — nothing approved, no credential — happen before that.
        const failed = body.latestJob?.status === "failed" || body.latestRun?.status === "failed";
        setSyncFailed(failed);
        setSyncError(failed ? (body.latestJob?.error ?? body.latestRun?.error ?? null) : null);
        setSyncStatus(body.latestJob?.status ?? body.latestRun?.status ?? null);
        // A job whose lease lapsed is not progress. Treating it as progress is
        // what disabled the refresh button — the one control that recovers from
        // it — and left the page insisting a refresh was under way.
        setSyncStalled(Boolean(body.latestJob?.stalled));
      }
    } catch {
      setError(ar ? "تعذر الاتصال بالخادم." : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, queryMetricKeys, preset, ar]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runSync() {
    if (!workspaceId) return;
    setSyncing(true);
    setError(null);
    try {
      const response = await workspaceFetch(workspaceId, "/api/v1/sync", { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(String(body.error ?? (ar ? "تعذر بدء التحديث." : "Could not start the refresh.")));
        return;
      }
      setSyncStatus("queued");
    } finally {
      setSyncing(false);
    }
  }

  // In flight for the purposes of the button and the poll: queued or running,
  // and only while something is actually holding the job.
  const syncInFlight = (syncStatus === "queued" || syncStatus === "running") && !syncStalled;

  useEffect(() => {
    if (!syncInFlight) return;
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [syncInFlight, load]);

  async function saveDraft(publish: boolean) {
    if (!workspaceId || !template) return;
    setSaving(true);
    try {
      const response = await workspaceFetch(workspaceId, "/api/v1/dashboards", {
        method: "POST",
        body: JSON.stringify({ key: template.key, definition: draft, title: template.title }),
      });
      const body = await response.json();
      if (!response.ok) {
        setIssues(body.issues ?? []);
        return;
      }
      setIssues(body.issues ?? []);

      if (publish) {
        await workspaceFetch(workspaceId, "/api/v1/dashboards", {
          method: "PATCH",
          body: JSON.stringify({ key: template.key, action: "publish" }),
        });
        setEditing(false);
      }
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function suggest(request: string) {
    if (!workspaceId) return;
    const response = await workspaceFetch(workspaceId, "/api/v1/dashboards/suggest", {
      method: "POST",
      body: JSON.stringify({ request }),
    });
    if (!response.ok) return;
    const body = await response.json();
    // Merged, not replaced: a suggestion adds to what is already on the board
    // rather than discarding work the customer already did.
    setDraft((current) => ({
      version: 1,
      widgets: [...current.widgets, ...(body.suggestion?.widgets ?? [])],
    }));
  }

  if (!workspace) return <Notice tone="warning">{t("workspace_none")}</Notice>;

  const byKey = new Map<string, MetricValue[]>();
  for (const value of values) {
    if (!byKey.has(value.metricKey)) byKey.set(value.metricKey, []);
    byKey.get(value.metricKey)!.push(value);
  }

  const published = Boolean(generation);

  return (
    <div className="space-y-6">
      <PageHeader
        title={template ? (ar ? template.title.ar : template.title.en) : t("nav_dashboards")}
        subtitle={
          ar
            ? "كل رقم بيقدر يشرح معادلته وتاريخه ومصدره. الشرطة معناها «غير متاح» مش صفر."
            : "Every number can explain its formula, date basis and source. A dash means unavailable, not zero."
        }
        actions={
          <>
            {template && can(workspace, "dashboard.publish") && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDraft(template.definition);
                  setIssues([]);
                  setEditing((value) => !value);
                }}
              >
                {editing ? <Undo2 className="size-4" /> : <PencilLine className="size-4" />}
                {editing ? (ar ? "إلغاء" : "Cancel") : ar ? "تعديل" : "Edit"}
              </Button>
            )}
            {can(workspace, "sync.run") && (
              <Button
                size="sm"
                variant="secondary"
                onClick={runSync}
                disabled={syncing || syncInFlight}
              >
                {syncing || syncInFlight ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {syncStalled
                  ? ar
                    ? "أعد المحاولة"
                    : "Try again"
                  : syncStatus === "queued"
                    ? ar
                      ? "في انتظار التحديث"
                      : "Refresh queued"
                    : syncStatus === "running"
                      ? ar
                        ? "جاري التحديث"
                        : "Refreshing"
                      : ar
                        ? "تحديث البيانات"
                        : "Refresh data"}
              </Button>
            )}
          </>
        }
      />

      {error && <Notice tone="danger">{error}</Notice>}

      {syncStalled && (
        <Notice
          tone="warning"
          title={ar ? "التحديث وقف من غير ما يخلّص" : "The refresh stopped without finishing"}
        >
          {ar
            ? "آخر تحديث اتسجّل باسم عامل مابقاش شغال — غالبًا وقع أثناء إعادة تشغيل أو نشر. اضغط «أعد المحاولة» عشان تبدأ واحد جديد."
            : "The last refresh was claimed by a worker that is no longer running — usually a restart or a deploy caught it mid-run. Press Try again to start a fresh one."}
        </Notice>
      )}

      {syncInFlight && (
        <Notice
          tone="brand"
          icon={<Loader2 className="size-4 animate-spin" />}
          title={ar ? "التحديث شغال في الخلفية" : "The refresh is running in the background"}
        >
          {ar
            ? "تقدر تسيب الصفحة؛ آخر بيانات ناجحة هتفضل ظاهرة لحد ما التحديث الجديد يكتمل."
            : "You can leave this page; the last successful data remains visible until the new refresh completes."}
        </Notice>
      )}

      {!loading && dashboards.length === 0 && (
        <Notice tone="neutral" title={ar ? "مفيش لوحة متاحة لسه" : "No dashboard is available yet"}>
          {ar
            ? "انشر خريطة الحقول الأول، وبعدها القوالب الجاهزة هتظهر هنا تلقائيًا."
            : "Publish the field mapping first; starter dashboards will then appear here automatically."}
        </Notice>
      )}

      {dashboards.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
          <SelectField
            label={ar ? "اللوحة" : "Dashboard"}
            value={selectedKey}
            onChange={(event) => {
              setSelectedKey(event.target.value);
              setEditing(false);
            }}
          >
            {dashboards.map((option) => (
              <option key={option.key} value={option.key}>
                {(ar ? option.title.ar : option.title.en) +
                  (option.status === "draft" ? (ar ? " (مسودة)" : " (draft)") : "")}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={ar ? "الفترة" : "Period"}
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
          >
            <option value="month">{ar ? "الشهر الحالي" : "This month"}</option>
            <option value="last30">{ar ? "آخر ٣٠ يوم" : "Last 30 days"}</option>
            <option value="year">{ar ? "من بداية السنة" : "Year to date"}</option>
          </SelectField>
        </div>
      )}

      {/* A failed refresh is reported whether or not anything was ever
          published. Gating this on `published` meant the very first refresh —
          the one most likely to fail, and the only one the customer cannot
          diagnose from the data in front of them — failed in silence, leaving
          "never synced" as the sole explanation of a refresh that had in fact
          run and lost. */}
      {syncFailed && (
        <Notice
          tone="danger"
          title={published ? t("last_good") : ar ? "فشل تحديث البيانات" : "The data refresh failed"}
        >
          <p>
            {published
              ? ar
                ? "آخر محاولة تحديث فشلت. الأرقام المعروضة من آخر تحديث ناجح."
                : "The latest refresh failed. The figures below are from the last successful one."
              : ar
                ? "آخر محاولة تحديث فشلت، وماحصلش أي نشر بيانات قبل كده."
                : "The latest refresh failed, and no data had been published before it."}
          </p>
          {/* The reason verbatim, already redacted server-side. Paraphrasing it
              into "something went wrong" is what left the customer with nothing
              to act on. */}
          {syncError && <p className="mt-2 font-mono text-xs break-words">{syncError}</p>}
        </Notice>
      )}

      {!published && !syncFailed && (
        <Notice tone="warning" title={t("never_synced")}>
          {ar
            ? "مفيش بيانات منشورة لحد دلوقتي. اعتمد الخريطة وشغّل تحديث البيانات."
            : "No data has been published yet. Approve the mapping and run a data refresh."}
        </Notice>
      )}

      {editing ? (
        <Builder
          definition={draft}
          metrics={metrics}
          issues={issues}
          busy={saving}
          onChange={setDraft}
          onSave={() => saveDraft(false)}
          onPublish={() => saveDraft(true)}
          onSuggest={suggest}
        />
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {(template?.definition.widgets ?? []).map((widget) => (
            <div
              key={widget.id}
              className={cn(
                "col-span-12",
                widget.span <= 3 ? "sm:col-span-6 lg:col-span-3" : "lg:col-span-6",
              )}
            >
              <WidgetView widget={widget} values={byKey} currency={workspace.baseCurrency} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetView({
  widget,
  values,
  currency,
}: {
  widget: Widget;
  values: Map<string, MetricValue[]>;
  currency: string;
}) {
  const { lang } = useI18n();
  const ar = lang === "ar";

  if (widget.kind === "text") {
    return (
      <Notice
        tone="neutral"
        icon={<Info className="size-4" />}
        title={ar ? widget.title.ar : widget.title.en}
      >
        {widget.body ? (ar ? widget.body.ar : widget.body.en) : null}
      </Notice>
    );
  }

  if (widget.kind === "kpi") {
    const value = values.get(widget.metricKeys[0])?.[0];
    return (
      <KpiCard title={ar ? widget.title.ar : widget.title.en} value={value} currency={currency} />
    );
  }

  if (widget.kind === "bar") {
    const series = widget.metricKeys
      .map((key) => ({ key, value: values.get(key)?.[0] }))
      .filter((entry) => entry.value);
    const max = Math.max(...series.map((entry) => entry.value?.value ?? 0), 1);

    return (
      <Card>
        <CardHeader
          icon={<BarChart3 className="size-4" />}
          title={ar ? widget.title.ar : widget.title.en}
        />
        <CardBody className="space-y-3">
          {series.map((entry) => (
            <div key={entry.key}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="text-text-muted">{entry.key}</span>
                <span className="font-medium tabular-nums">
                  {renderValue(entry.value, currency, lang)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full bg-brand"
                  style={{
                    // A null metric has no bar at all rather than a zero-width
                    // one, which would read as "we measured zero".
                    width:
                      entry.value?.value === null
                        ? "0%"
                        : `${((entry.value?.value ?? 0) / max) * 100}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </CardBody>
      </Card>
    );
  }

  // table
  const rows = values.get(widget.metricKeys[0]) ?? [];
  return (
    <Card>
      <CardHeader title={ar ? widget.title.ar : widget.title.en} />
      <CardBody>
        <DataTable>
          <thead>
            <tr>
              <Th>{widget.dimension ?? (ar ? "البند" : "Item")}</Th>
              <Th>{ar ? "القيمة" : "Value"}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {/* A row with no dimension is not a company called
                    "accounting.invoiced" — it is the ungrouped total, which is
                    what a metric returns before any data exists to group. */}
                <Td>{(row.dimensions && Object.values(row.dimensions)[0]) || DASH}</Td>
                <Td className="tabular-nums">{renderValue(row, currency, lang)}</Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </CardBody>
    </Card>
  );
}

function KpiCard({
  title,
  value,
  currency,
}: {
  title: string;
  value: MetricValue | undefined;
  currency: string;
}) {
  const { lang, t } = useI18n();
  const ar = lang === "ar";
  const [open, setOpen] = useState(false);

  return (
    <Card className="h-full">
      <CardBody className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-text-muted">{title}</p>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={t("how_calculated")}
            className="text-text-subtle hover:text-text"
          >
            <Info className="size-3.5" />
          </button>
        </div>

        <p className="text-2xl font-semibold tabular-nums">{renderValue(value, currency, lang)}</p>

        {value && !value.isAvailable && (
          <Badge tone="neutral">{ar ? "غير متاح" : "Not available"}</Badge>
        )}

        {/* The explainability drawer. Every metric can say where it came from,
            which is the difference between a number and a claim. */}
        {open && value && (
          <div className="space-y-1.5 rounded-md border border-border bg-surface-2 p-2.5 text-xs">
            <p>
              <span className="text-text-muted">{t("formula")}: </span>
              {ar ? value.formula.ar : value.formula.en}
            </p>
            <p>
              <span className="text-text-muted">{t("date_basis")}: </span>
              {value.datePolicy ?? (ar ? "غير مرتبط بفترة" : "not period-filtered")}
            </p>
            <p>
              <span className="text-text-muted">{t("mapping_version")}: </span>v
              {value.metricVersion}
            </p>
            {!value.isAvailable && (
              <p className="text-text-muted">
                {t("why_dash")}
                {value.unavailableReason ? ` (${value.unavailableReason})` : ""}
              </p>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** A null metric always renders as an em dash — never 0, NaN or Infinity. */
function renderValue(value: MetricValue | undefined, currency: string, lang: "ar" | "en"): string {
  if (!value || value.value === null) return DASH;
  if (value.unit === "currency") return formatCurrency(value.value, currency, lang);
  if (value.unit === "percent")
    return `${formatNumber(value.value, lang, { maximumFractionDigits: 1 })}%`;
  return formatNumber(value.value, lang);
}
