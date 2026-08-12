// Dashboard builder.
//
// Reorder with buttons rather than drag-and-drop: a keyboard user and a phone
// user both get the same capability, and "move up" is unambiguous where a drop
// target is not. Drag can be added on top later; it cannot be the only way.
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Notice,
  SelectField,
} from "@/components/ui/primitives";
import type { DashboardDefinition, Widget, WidgetKind } from "@/platform/dashboards/templates";
import { blankWidget } from "@/platform/dashboards/validate";

export interface MetricOption {
  key: string;
  label: { ar: string; en: string };
  unit: string;
  allowedDimensions: string[];
  available: boolean;
}

export interface BuilderIssue {
  widgetId: string;
  reason: string;
  detail: string;
}

const KINDS: Array<{ kind: WidgetKind; ar: string; en: string }> = [
  { kind: "kpi", ar: "رقم", en: "KPI" },
  { kind: "bar", ar: "أعمدة", en: "Bars" },
  { kind: "table", ar: "جدول", en: "Table" },
  { kind: "text", ar: "نص", en: "Text" },
];

export function Builder({
  definition,
  metrics,
  issues,
  busy,
  onChange,
  onSave,
  onPublish,
  onSuggest,
}: {
  definition: DashboardDefinition;
  metrics: MetricOption[];
  issues: BuilderIssue[];
  busy: boolean;
  onChange: (next: DashboardDefinition) => void;
  onSave: () => void;
  onPublish: () => void;
  onSuggest: (request: string) => Promise<void>;
}) {
  const { lang, t } = useI18n();
  const ar = lang === "ar";
  const [prompt, setPrompt] = useState("");
  const [suggesting, setSuggesting] = useState(false);

  const issuesByWidget = useMemo(() => {
    const map = new Map<string, BuilderIssue[]>();
    for (const issue of issues) {
      if (!map.has(issue.widgetId)) map.set(issue.widgetId, []);
      map.get(issue.widgetId)!.push(issue);
    }
    return map;
  }, [issues]);

  function update(index: number, patch: Partial<Widget>) {
    const widgets = definition.widgets.map((widget, i) =>
      i === index ? { ...widget, ...patch } : widget,
    );
    onChange({ ...definition, widgets });
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= definition.widgets.length) return;
    const widgets = [...definition.widgets];
    [widgets[index], widgets[target]] = [widgets[target], widgets[index]];
    onChange({ ...definition, widgets });
  }

  function remove(index: number) {
    onChange({ ...definition, widgets: definition.widgets.filter((_, i) => i !== index) });
  }

  function add(kind: WidgetKind) {
    onChange({
      ...definition,
      widgets: [...definition.widgets, blankWidget(kind, definition.widgets.length)],
    });
  }

  async function runSuggest() {
    setSuggesting(true);
    try {
      await onSuggest(prompt);
      setPrompt("");
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<Sparkles className="size-4" />}
          title={ar ? "اوصف اللي عايز تشوفه" : "Describe what you want to see"}
          subtitle={
            ar
              ? "هنقترح لوحة مبدئية وانت تعدّلها. الاقتراح بيمرّ بنفس التحقق زي أي لوحة."
              : "We propose a starting point you then edit. The suggestion passes the same validation as any dashboard."
          }
        />
        <CardBody className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <Field
              label={ar ? "الطلب" : "Request"}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={
                ar
                  ? "المحصّل والفرص الجديدة، والأوامر حسب المسؤول"
                  : "collected cash and new leads, orders by salesperson"
              }
            />
          </div>
          <Button
            variant="secondary"
            disabled={suggesting || prompt.trim().length < 3}
            onClick={runSuggest}
          >
            {suggesting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {ar ? "اقترح" : "Suggest"}
          </Button>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        {KINDS.map((option) => (
          <Button key={option.kind} size="sm" variant="secondary" onClick={() => add(option.kind)}>
            <Plus className="size-3.5" />
            {ar ? option.ar : option.en}
          </Button>
        ))}
        <div className="ms-auto flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={onSave}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {ar ? "حفظ كمسودة" : "Save draft"}
          </Button>
          <Button size="sm" disabled={busy} onClick={onPublish}>
            {t("publish")}
          </Button>
        </div>
      </div>

      {definition.widgets.length === 0 && (
        <Notice tone="neutral">
          {ar
            ? "اللوحة فاضية. ضيف عنصر أو اوصف اللي عايزه فوق."
            : "This dashboard is empty. Add a widget, or describe what you want above."}
        </Notice>
      )}

      <div className="space-y-3">
        {definition.widgets.map((widget, index) => {
          const widgetIssues = issuesByWidget.get(widget.id) ?? [];
          const primary = metrics.find((metric) => metric.key === widget.metricKeys[0]);
          const dimensions = primary?.allowedDimensions ?? [];

          return (
            <Card key={widget.id}>
              <CardBody className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="brand">{widget.kind}</Badge>
                  <span className="text-sm text-text-muted">#{index + 1}</span>
                  <div className="ms-auto flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={ar ? "لأعلى" : "Move up"}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={ar ? "لأسفل" : "Move down"}
                      disabled={index === definition.widgets.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={ar ? "حذف" : "Remove"}
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="size-4 text-danger" />
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label={ar ? "العنوان (عربي)" : "Title (Arabic)"}
                    value={widget.title.ar}
                    onChange={(event) =>
                      update(index, { title: { ...widget.title, ar: event.target.value } })
                    }
                  />
                  <Field
                    label={ar ? "العنوان (إنجليزي)" : "Title (English)"}
                    value={widget.title.en}
                    ltr
                    onChange={(event) =>
                      update(index, { title: { ...widget.title, en: event.target.value } })
                    }
                  />

                  {widget.kind !== "text" && (
                    <SelectField
                      label={ar ? "المقياس" : "Metric"}
                      value={widget.metricKeys[0] ?? ""}
                      onChange={(event) =>
                        update(index, {
                          metricKeys: event.target.value ? [event.target.value] : [],
                          // The old dimension may not exist on the new metric.
                          dimension: undefined,
                        })
                      }
                    >
                      <option value="">{ar ? "اختر مقياسًا" : "Choose a metric"}</option>
                      {metrics.map((metric) => (
                        <option key={metric.key} value={metric.key}>
                          {(ar ? metric.label.ar : metric.label.en) +
                            (metric.available ? "" : ar ? " — غير متاح" : " — not available")}
                        </option>
                      ))}
                    </SelectField>
                  )}

                  {widget.kind !== "text" && widget.kind !== "kpi" && dimensions.length > 0 && (
                    <SelectField
                      label={ar ? "التقسيم" : "Break down by"}
                      value={widget.dimension ?? ""}
                      onChange={(event) =>
                        update(index, { dimension: event.target.value || undefined })
                      }
                    >
                      <option value="">{ar ? "بدون تقسيم" : "No breakdown"}</option>
                      {dimensions.map((dimension) => (
                        <option key={dimension} value={dimension}>
                          {dimension}
                        </option>
                      ))}
                    </SelectField>
                  )}

                  <SelectField
                    label={ar ? "العرض" : "Width"}
                    value={String(widget.span)}
                    onChange={(event) => update(index, { span: Number(event.target.value) })}
                  >
                    <option value="3">{ar ? "ربع" : "Quarter"}</option>
                    <option value="6">{ar ? "نص" : "Half"}</option>
                    <option value="12">{ar ? "كامل" : "Full"}</option>
                  </SelectField>
                </div>

                {widget.kind === "text" && (
                  <Field
                    label={ar ? "النص" : "Body"}
                    value={widget.body?.ar ?? ""}
                    onChange={(event) =>
                      update(index, {
                        body: {
                          ar: event.target.value,
                          en: widget.body?.en ?? event.target.value,
                        },
                      })
                    }
                  />
                )}

                {widgetIssues.map((issue, issueIndex) => (
                  <Notice
                    key={issueIndex}
                    tone={issue.reason === "metric_unavailable" ? "warning" : "danger"}
                    icon={<TriangleAlert className="size-4" />}
                  >
                    {issue.detail}
                  </Notice>
                ))}
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
