import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Info, Loader2, RefreshCw } from "lucide-react";
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
import { DASHBOARD_TEMPLATES, type Widget } from "@/platform/dashboards/templates";
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

  const [templateKey, setTemplateKey] = useState(DASHBOARD_TEMPLATES[0].key);
  const [preset, setPreset] = useState("year");
  const [values, setValues] = useState<MetricValue[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [generation, setGeneration] = useState<{ published_at?: string } | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);

  const template = useMemo(
    () => DASHBOARD_TEMPLATES.find((d) => d.key === templateKey) ?? DASHBOARD_TEMPLATES[0],
    [templateKey],
  );

  const metricKeys = useMemo(
    () => [...new Set(template.definition.widgets.flatMap((w) => w.metricKeys))],
    [template],
  );

  const load = useCallback(async () => {
    if (!workspaceId || !metricKeys.length) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [metricsRes, syncRes] = await Promise.all([
        workspaceFetch(workspaceId, "/api/v1/metrics/query", {
          method: "POST",
          body: JSON.stringify({ metricKeys, dateRange: presetRange(preset) }),
        }),
        workspaceFetch(workspaceId, "/api/v1/sync"),
      ]);
      if (metricsRes.ok) setValues((await metricsRes.json()).values ?? []);
      if (syncRes.ok) {
        const body = await syncRes.json();
        setGeneration(body.generation ?? null);
        setSyncFailed(body.latestRun?.status === "failed");
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, metricKeys, preset]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runSync() {
    if (!workspaceId) return;
    setSyncing(true);
    try {
      await workspaceFetch(workspaceId, "/api/v1/sync", { method: "POST" });
      setTimeout(() => void load(), 2_000);
    } finally {
      setSyncing(false);
    }
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
        title={ar ? template.title.ar : template.title.en}
        subtitle={
          ar
            ? "كل رقم بيقدر يشرح معادلته وتاريخه ومصدره. الشرطة معناها «غير متاح» مش صفر."
            : "Every number can explain its formula, date basis and source. A dash means unavailable, not zero."
        }
        actions={
          can(workspace, "sync.run") ? (
            <Button size="sm" variant="secondary" onClick={runSync} disabled={syncing}>
              {syncing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {ar ? "تحديث البيانات" : "Refresh data"}
            </Button>
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
        <SelectField
          label={ar ? "اللوحة" : "Dashboard"}
          value={templateKey}
          onChange={(event) => setTemplateKey(event.target.value)}
        >
          {DASHBOARD_TEMPLATES.map((option) => (
            <option key={option.key} value={option.key}>
              {ar ? option.title.ar : option.title.en}
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

      {!published && (
        <Notice tone="warning" title={t("never_synced")}>
          {ar
            ? "مفيش بيانات منشورة لحد دلوقتي. اعتمد الخريطة وشغّل تحديث البيانات."
            : "No data has been published yet. Approve the mapping and run a data refresh."}
        </Notice>
      )}

      {/* Last-good: a failed refresh never blanks a healthy dashboard, and it
          never presents stale data as fresh either. */}
      {published && syncFailed && (
        <Notice tone="warning" title={t("last_good")}>
          {ar
            ? "آخر محاولة تحديث فشلت. الأرقام المعروضة من آخر تحديث ناجح."
            : "The latest refresh failed. The figures below are from the last successful one."}
        </Notice>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {template.definition.widgets.map((widget) => (
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
                <Td>
                  {row.dimensions ? (Object.values(row.dimensions)[0] ?? DASH) : row.metricKey}
                </Td>
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
