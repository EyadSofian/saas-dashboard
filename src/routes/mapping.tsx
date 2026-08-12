import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleHelp,
  Loader2,
  Lock,
  Sparkles,
  X,
} from "lucide-react";
import { useI18n, Ltr } from "@/lib/i18n";
import { can, useSession, workspaceFetch } from "@/lib/session";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Notice,
  PageHeader,
  SelectField,
  Skeleton,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/mapping")({ component: MappingPage });

interface Mapping {
  canonicalField: string;
  odooModel: string | null;
  odooField: string | null;
  confidence: number | null;
  evidence: Array<{ kind: string; detail: string }>;
  alternatives: Array<{ odooModel: string; odooField: string; confidence: number; reason: string }>;
  riskLevel: string;
  status: string;
  explanationAr: string;
  explanationEn: string;
}

interface Policy {
  policyKey: string;
  value: string;
  options: Array<{ value: string; label: { ar: string; en: string } }>;
  status: string;
  question: { ar: string; en: string };
}

interface Concept {
  key: string;
  entity: string;
  type: string;
  required: boolean;
  riskLevel: string;
  label: { ar: string; en: string };
  description: { ar: string; en: string };
}

interface Manifest {
  id: string;
  version: number;
  status: string;
  counts: { total: number; approved: number; needsReview: number; unavailable: number };
}

interface Blocker {
  kind: string;
  key: string;
  reason: string;
}

/** Below this the proposal is shown as unresolved, not as a recommendation. */
const PRESENT_THRESHOLD = 0.7;

function MappingPage() {
  const { lang, t } = useI18n();
  const ar = lang === "ar";
  const { workspace, refresh: refreshSession } = useSession();
  const workspaceId = workspace?.id ?? null;
  const mayApprove = can(workspace, "mapping.approve");

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [blockers, setBlockers] = useState<Blocker[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const response = await workspaceFetch(workspaceId, "/api/v1/mapping");
      if (!response.ok) return;
      const body = await response.json();
      setManifest(body.manifest ?? null);
      setMappings(body.mappings ?? []);
      setPolicies(body.policies ?? []);
      setConcepts(body.concepts ?? []);
      setBlockers(body.blockers ?? []);
      setSelected((current) => current ?? body.mappings?.[0]?.canonicalField ?? null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const conceptsByKey = useMemo(
    () => new Map(concepts.map((concept) => [concept.key, concept])),
    [concepts],
  );

  const manifestCounts = useMemo(
    () => ({
      total: mappings.length,
      approved: mappings.filter((mapping) => mapping.status === "approved").length,
      needsReview: mappings.filter((mapping) => mapping.status === "needs_review").length,
      unavailable: mappings.filter((mapping) => mapping.status === "unavailable").length,
    }),
    [mappings],
  );

  async function propose() {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await workspaceFetch(workspaceId, "/api/v1/mapping", { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(
          String(body.error ?? (ar ? "تعذر توليد الاقتراح." : "Could not generate a proposal.")),
        );
        return;
      }
      await load();
      await refreshSession();
    } finally {
      setBusy(false);
    }
  }

  async function decide(patch: Record<string, unknown>) {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const response = await workspaceFetch(workspaceId, "/api/v1/mapping", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (response.ok) {
        const next = mappings.find(
          (mapping) => mapping.canonicalField !== selected && mapping.status === "needs_review",
        );
        if (next && "canonicalField" in patch) setSelected(next.canonicalField);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await workspaceFetch(workspaceId, "/api/v1/mapping/publish", {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) {
        setBlockers(body.blockers ?? []);
        setError(
          ar
            ? "فيه حاجات لسه محتاجة اعتماد قبل النشر."
            : "Some items still need approval before publishing.",
        );
        return;
      }
      await load();
      await refreshSession();
    } finally {
      setBusy(false);
    }
  }

  if (!workspace) return <Notice tone="warning">{t("workspace_none")}</Notice>;
  if (loading) return <Skeleton className="h-64 w-full" />;

  if (!manifest) {
    const readyForProposal = ["snapshot_ready", "mapping_review", "published"].includes(
      workspace.onboardingState,
    );
    const Arrow = ar ? ArrowLeft : ArrowRight;
    return (
      <div className="space-y-6">
        <PageHeader title={t("mapping_title")} />
        <Notice tone="neutral" icon={<Sparkles className="size-4" />}>
          {ar
            ? "بعد ما نقرا بنية بياناتك، هنقترح معنى كل حقل وانت تراجع وتعتمد."
            : "Once your structure is read, we propose what each field means and you review and approve."}
        </Notice>
        {readyForProposal ? (
          <Button onClick={propose} disabled={busy || !mayApprove}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {busy
              ? ar
                ? "جاري تحليل الحقول"
                : "Analyzing fields"
              : ar
                ? "ولّد الاقتراح"
                : "Generate proposal"}
          </Button>
        ) : (
          <Notice
            tone="warning"
            title={ar ? "اقرأ بنية أودو الأول" : "Discover the Odoo structure first"}
          >
            <p>
              {ar
                ? "المابينج بيتبني من الموديلات والحقول اللي اكتشفناها، فمحتاج تكمل خطوة الربط الأول."
                : "Mapping is built from discovered models and fields, so complete the connection step first."}
            </p>
            <Link to="/onboarding" className="mt-3 inline-block">
              <Button size="sm">
                {ar ? "ارجع للربط" : "Go to connection"}
                <Arrow className="size-4" />
              </Button>
            </Link>
          </Notice>
        )}
      </div>
    );
  }

  const current = mappings.find((m) => m.canonicalField === selected) ?? null;
  const currentConcept = current ? conceptsByKey.get(current.canonicalField) : null;
  const openPolicies = policies.filter((p) => p.status !== "approved");

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("mapping_title")}
        subtitle={
          ar
            ? "الذكاء الاصطناعي بيقترح، وانت اللي بتعتمد. أي تعريف مالي لازم اعتماد صريح."
            : "AI proposes, you approve. Every financial definition needs explicit approval."
        }
        actions={
          <>
            <Badge tone="neutral">v{manifest.version}</Badge>
            <Button
              size="sm"
              disabled={busy || !mayApprove || blockers.length > 0}
              onClick={publish}
            >
              {t("publish")}
            </Button>
          </>
        }
      />

      {error && <Notice tone="danger">{error}</Notice>}

      {manifest.status === "published" ? (
        <Notice tone="success" icon={<Check className="size-4" />}>
          {ar
            ? "الخريطة معتمدة ومنشورة. أي تعديل بيحتاج إصدار جديد."
            : "The mapping is approved and published. Any change needs a new version."}
        </Notice>
      ) : blockers.length > 0 ? (
        <Notice
          tone="warning"
          icon={<Lock className="size-4" />}
          title={
            ar
              ? `${blockers.length} عنصر لسه محتاج اعتماد قبل النشر`
              : `${blockers.length} item(s) still need approval before publishing`
          }
        >
          {ar
            ? "التعريفات المالية وسياسات التقارير لازم تتعتمد صراحةً — لوحة مبنية على تعريف غير معتمد أسوأ من غير لوحة."
            : "Financial definitions and reporting policies must be explicitly approved — a dashboard built on an unapproved definition is worse than none."}
        </Notice>
      ) : null}

      {/* Policy questions come first: they are business decisions no schema
          inspection can answer, and they change what the numbers mean. */}
      {openPolicies.length > 0 && (
        <Card>
          <CardHeader
            icon={<CircleHelp className="size-4" />}
            title={ar ? "أسئلة لازم تجاوب عليها" : "Questions only you can answer"}
          />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {openPolicies.map((policy) => (
              <SelectField
                key={policy.policyKey}
                label={ar ? policy.question.ar : policy.question.en}
                value={policy.value}
                disabled={!mayApprove || busy}
                onChange={(event) =>
                  void decide({ policyKey: policy.policyKey, value: event.target.value })
                }
              >
                {policy.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {ar ? option.label.ar : option.label.en}
                  </option>
                ))}
              </SelectField>
            ))}
          </CardBody>
        </Card>
      )}

      <div className="grid grid-cols-3 gap-3">
        <MappingStat
          label={ar ? "تم الاعتماد" : "Approved"}
          value={manifestCounts.approved}
          tone="success"
        />
        <MappingStat
          label={ar ? "محتاج مراجعة" : "Needs review"}
          value={manifestCounts.needsReview}
          tone="warning"
        />
        <MappingStat
          label={ar ? "غير متاح" : "Unavailable"}
          value={manifestCounts.unavailable}
          tone="neutral"
        />
      </div>

      <div className="lg:hidden">
        <SelectField
          label={ar ? "الحقل اللي بتراجعه" : "Field under review"}
          value={selected ?? ""}
          onChange={(event) => setSelected(event.target.value)}
        >
          {mappings.map((mapping) => {
            const concept = conceptsByKey.get(mapping.canonicalField);
            return (
              <option key={mapping.canonicalField} value={mapping.canonicalField}>
                {concept ? (ar ? concept.label.ar : concept.label.en) : mapping.canonicalField}
                {mapping.status === "approved" ? (ar ? " — معتمد" : " — approved") : ""}
              </option>
            );
          })}
        </SelectField>
      </div>

      {/* Three panels on desktop, sequential on mobile: concept list, the
          decision, then the evidence behind it. */}
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr_20rem]">
        <Card className="hidden max-h-[32rem] overflow-y-auto lg:block">
          <ul className="divide-y divide-border">
            {mappings.map((mapping) => {
              const concept = conceptsByKey.get(mapping.canonicalField);
              const active = mapping.canonicalField === selected;
              return (
                <li key={mapping.canonicalField}>
                  <button
                    type="button"
                    onClick={() => setSelected(mapping.canonicalField)}
                    className={cn(
                      "flex w-full items-start justify-between gap-2 p-3 text-start text-sm hover:bg-surface-2",
                      active && "bg-brand-soft",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {concept
                          ? ar
                            ? concept.label.ar
                            : concept.label.en
                          : mapping.canonicalField}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        <Ltr>{mapping.canonicalField}</Ltr>
                      </span>
                    </span>
                    <StatusDot status={mapping.status} risk={mapping.riskLevel} />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card>
          {current && currentConcept ? (
            <>
              <CardHeader
                title={ar ? currentConcept.label.ar : currentConcept.label.en}
                subtitle={ar ? currentConcept.description.ar : currentConcept.description.en}
                actions={
                  currentConcept.riskLevel === "high" ? (
                    <Badge tone="danger">{ar ? "مالي" : "Financial"}</Badge>
                  ) : null
                }
              />
              <CardBody className="space-y-4">
                {currentConcept.riskLevel === "high" && (
                  <Notice tone="warning" icon={<AlertTriangle className="size-4" />}>
                    {t("mapping_financial_warning")}
                  </Notice>
                )}

                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-text-muted">{t("mapping_source")}</p>
                  {current.odooField ? (
                    <p className="mt-1 font-mono text-sm">
                      <Ltr>
                        {current.odooModel}.{current.odooField}
                      </Ltr>
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-text-muted">{t("unavailable")}</p>
                  )}

                  <div className="mt-2 flex items-center gap-2">
                    <ConfidenceBar value={current.confidence} />
                  </div>
                  <p className="mt-2 text-sm">
                    {ar ? current.explanationAr : current.explanationEn}
                  </p>
                </div>

                {current.alternatives.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs text-text-muted">
                      {ar ? "بدائل مقترحة" : "Alternatives"}
                    </p>
                    <ul className="space-y-1.5">
                      {current.alternatives.map((alt) => (
                        <li
                          key={`${alt.odooModel}.${alt.odooField}`}
                          className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm"
                        >
                          <span className="font-mono text-xs">
                            <Ltr>
                              {alt.odooModel}.{alt.odooField}
                            </Ltr>
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!mayApprove || busy}
                            onClick={() =>
                              void decide({
                                canonicalField: current.canonicalField,
                                status: "approved",
                                odooModel: alt.odooModel,
                                odooField: alt.odooField,
                              })
                            }
                          >
                            {ar ? "استخدم ده" : "Use this"}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={!mayApprove || busy || !current.odooField}
                    onClick={() =>
                      void decide({ canonicalField: current.canonicalField, status: "approved" })
                    }
                  >
                    <Check className="size-4" />
                    {t("approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!mayApprove || busy}
                    onClick={() =>
                      void decide({ canonicalField: current.canonicalField, status: "rejected" })
                    }
                  >
                    <X className="size-4" />
                    {t("reject")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!mayApprove || busy}
                    onClick={() =>
                      void decide({ canonicalField: current.canonicalField, status: "unavailable" })
                    }
                  >
                    {ar ? "غير متاح عندي" : "Not available"}
                  </Button>
                </div>
              </CardBody>
            </>
          ) : (
            <CardBody>
              <p className="text-sm text-text-muted">
                {ar ? "اختر مفهومًا من القائمة." : "Select a concept from the list."}
              </p>
            </CardBody>
          )}
        </Card>

        <Card>
          <CardHeader title={t("mapping_evidence")} />
          <CardBody>
            {current?.evidence.length ? (
              <ul className="space-y-2 text-sm">
                {current.evidence.map((item, index) => (
                  <li key={index} className="rounded-md border border-border p-2.5">
                    <p className="text-xs uppercase tracking-wide text-text-muted">{item.kind}</p>
                    {/* Evidence quotes customer metadata verbatim — it is shown
                        as data, and nothing acts on its contents. */}
                    <p className="mt-1 break-words">{item.detail}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">
                {ar ? "لا يوجد دليل مسجّل لهذا المفهوم." : "No evidence recorded for this concept."}
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function MappingStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "neutral";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      <div
        className={`mt-2 h-1 rounded-full ${tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-border-strong"}`}
      />
    </div>
  );
}

function StatusDot({ status, risk }: { status: string; risk: string }) {
  const { lang } = useI18n();
  const ar = lang === "ar";
  if (status === "approved") return <Badge tone="success">{ar ? "معتمد" : "OK"}</Badge>;
  if (status === "rejected") return <Badge tone="neutral">{ar ? "مرفوض" : "No"}</Badge>;
  if (status === "unavailable") return <Badge tone="neutral">—</Badge>;
  return <Badge tone={risk === "high" ? "danger" : "warning"}>{ar ? "مراجعة" : "Review"}</Badge>;
}

/**
 * Confidence is a ranking signal, not a probability. The bar is unlabelled by
 * percentage on purpose: showing "95%" invites a reader to treat a model's
 * self-report as calibrated accuracy, which it is not.
 */
function ConfidenceBar({ value }: { value: number | null }) {
  const { lang } = useI18n();
  const ar = lang === "ar";
  if (value === null || value === 0) {
    return <span className="text-xs text-text-muted">{ar ? "غير محسوم" : "Unresolved"}</span>;
  }
  const tone =
    value >= 0.85 ? "bg-success" : value >= PRESENT_THRESHOLD ? "bg-warning" : "bg-danger";
  const label =
    value >= 0.85
      ? ar
        ? "مطابقة قوية"
        : "Strong match"
      : value >= PRESENT_THRESHOLD
        ? ar
          ? "مطابقة محتملة"
          : "Likely match"
        : ar
          ? "غير محسوم"
          : "Unresolved";
  return (
    <>
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
        <span
          className={cn("block h-full", tone)}
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </span>
      <span className="text-xs text-text-muted">{label}</span>
    </>
  );
}
