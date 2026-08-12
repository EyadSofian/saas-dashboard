import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { DASH, formatNumber, useI18n } from "@/lib/i18n";
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
  Skeleton,
  Td,
  Th,
} from "@/components/ui/primitives";

export const Route = createFileRoute("/data-health")({ component: DataHealthPage });

interface ReconciliationCheck {
  checkKey: string;
  entity: string;
  measure: string;
  severity: string;
  sourceValue: number | null;
  canonicalValue: number | null;
  difference: number | null;
  tolerance: number;
  passed: boolean;
  unavailableReason: string | null;
}

interface QualityResult {
  ruleKey: string;
  severity: string;
  failingRows: number;
  totalRows: number;
  passed: boolean;
  detail: string;
}

interface ReconciliationRun {
  id: string;
  status: string;
  acceptedNote: string | null;
  finishedAt: string | null;
  checks: ReconciliationCheck[];
  quality: QualityResult[];
}

interface HealthRow {
  domain: string;
  status: "never" | "success" | "stale" | "failed";
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  rowCount: number | null;
}

function DataHealthPage() {
  const { lang, t } = useI18n();
  const ar = lang === "ar";
  const { workspace } = useSession();
  const [domains, setDomains] = useState<HealthRow[]>([]);
  const [run, setRun] = useState<ReconciliationRun | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const [healthRes, reconciliationRes] = await Promise.all([
        workspaceFetch(workspace.id, "/api/v1/data-health"),
        workspaceFetch(workspace.id, "/api/v1/reconciliation"),
      ]);
      if (healthRes.ok) setDomains((await healthRes.json()).domains ?? []);
      if (reconciliationRes.ok) setRun((await reconciliationRes.json()).run ?? null);
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  async function acceptWarnings() {
    if (!workspace || !run) return;
    setBusy(true);
    try {
      const response = await workspaceFetch(workspace.id, "/api/v1/reconciliation", {
        method: "POST",
        body: JSON.stringify({ runId: run.id, note }),
      });
      if (response.ok) {
        setNote("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  if (!workspace) return <Notice tone="warning">{t("workspace_none")}</Notice>;
  if (loading) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("nav_data_health")}
        subtitle={
          ar
            ? "«آخر نجاح» بيتحرك مع النجاح بس. محاولة فاشلة بتتسجّل جنبه، فمش ممكن بيانات قديمة تبان جديدة."
            : "Last success advances only on success. A failed attempt is recorded beside it, so stale data can never look fresh."
        }
      />

      {run && (
        <ReconciliationCard
          run={run}
          note={note}
          setNote={setNote}
          busy={busy}
          canAccept={can(workspace, "policy.approve")}
          onAccept={acceptWarnings}
        />
      )}

      <Card>
        <CardBody>
          <DataTable>
            <thead>
              <tr>
                <Th>{ar ? "المجال" : "Domain"}</Th>
                <Th>{ar ? "الحالة" : "Status"}</Th>
                <Th>{t("last_sync")}</Th>
                <Th>{ar ? "آخر محاولة" : "Last attempt"}</Th>
                <Th>{ar ? "الصفوف" : "Rows"}</Th>
              </tr>
            </thead>
            <tbody>
              {domains.map((row) => (
                <tr key={row.domain}>
                  <Td className="font-medium">{row.domain}</Td>
                  <Td>
                    <StatusBadge status={row.status} />
                  </Td>
                  <Td className="text-sm text-text-muted">{formatTime(row.lastSuccessAt, ar)}</Td>
                  <Td className="text-sm text-text-muted">{formatTime(row.lastAttemptAt, ar)}</Td>
                  <Td className="tabular-nums">{row.rowCount ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>

          {domains.some((d) => d.lastError) && (
            <div className="mt-4 space-y-2">
              {domains
                .filter((d) => d.lastError)
                .map((d) => (
                  <Notice key={d.domain} tone="danger" title={d.domain}>
                    {d.lastError}
                  </Notice>
                ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: HealthRow["status"] }) {
  const { t } = useI18n();
  if (status === "success")
    return (
      <Badge tone="success">
        <CheckCircle2 className="size-3" />
        {t("success")}
      </Badge>
    );
  if (status === "stale")
    return (
      <Badge tone="warning">
        <Clock className="size-3" />
        {t("stale")}
      </Badge>
    );
  if (status === "failed")
    return (
      <Badge tone="danger">
        <XCircle className="size-3" />
        {t("failed")}
      </Badge>
    );
  return (
    <Badge tone="neutral">
      <CircleDashed className="size-3" />
      {t("never_synced")}
    </Badge>
  );
}

function formatTime(value: string | null, ar: boolean): string {
  if (!value) return ar ? "—" : "—";
  return new Intl.DateTimeFormat(ar ? "ar-EG-u-nu-latn" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/**
 * What the product checked against Odoo, and what it found.
 *
 * Shows the source value beside ours for every measure, so "trust us" is
 * replaced by a number the customer can verify in their own ERP.
 */
function ReconciliationCard({
  run,
  note,
  setNote,
  busy,
  canAccept,
  onAccept,
}: {
  run: ReconciliationRun;
  note: string;
  setNote: (value: string) => void;
  busy: boolean;
  canAccept: boolean;
  onAccept: () => void;
}) {
  const { lang } = useI18n();
  const ar = lang === "ar";

  const failed = run.checks.filter((check) => !check.passed);
  const critical = failed.filter((check) => check.severity === "critical");
  const warnings = failed.filter((check) => check.severity !== "critical");
  const failingQuality = run.quality.filter((result) => !result.passed);

  return (
    <Card>
      <CardHeader
        icon={<ShieldCheck className="size-4" />}
        title={ar ? "المطابقة مع أودو" : "Reconciliation against Odoo"}
        subtitle={
          ar
            ? "المنتج بيقارن أرقامه بأودو قبل ما ينشر. النشر بيتمنع لو فيه فرق في رقم مالي."
            : "The product compares its figures with Odoo before publishing. A financial difference blocks publication."
        }
        actions={
          run.status === "passed" ? (
            <Badge tone="success">{ar ? "مطابق" : "Matched"}</Badge>
          ) : run.status === "failed" ? (
            <Badge tone="danger">{ar ? "فيه فرق" : "Mismatch"}</Badge>
          ) : (
            <Badge tone="warning">{ar ? "محتاج قبول" : "Needs acceptance"}</Badge>
          )
        }
      />
      <CardBody className="space-y-4">
        {critical.length > 0 && (
          <Notice
            tone="danger"
            icon={<AlertTriangle className="size-4" />}
            title={
              ar ? "فرق في رقم مالي — النشر متوقف" : "Financial difference — publication blocked"
            }
          >
            {ar
              ? "مفيش طريقة تتجاوز الفرق ده. لازم يتصلّح في الخريطة أو في أودو نفسه."
              : "There is no way to accept past this. It has to be fixed in the mapping or in Odoo itself."}
          </Notice>
        )}

        <DataTable>
          <thead>
            <tr>
              <Th>{ar ? "الفحص" : "Check"}</Th>
              <Th>{ar ? "في أودو" : "In Odoo"}</Th>
              <Th>{ar ? "عندنا" : "Ours"}</Th>
              <Th>{ar ? "الفرق" : "Difference"}</Th>
              <Th>{ar ? "النتيجة" : "Result"}</Th>
            </tr>
          </thead>
          <tbody>
            {run.checks.map((check) => (
              <tr key={check.checkKey}>
                <Td className="font-mono text-xs">{check.checkKey}</Td>
                <Td className="tabular-nums">
                  {check.sourceValue === null ? DASH : formatNumber(check.sourceValue, lang)}
                </Td>
                <Td className="tabular-nums">
                  {check.canonicalValue === null ? DASH : formatNumber(check.canonicalValue, lang)}
                </Td>
                <Td className="tabular-nums">
                  {check.difference === null ? DASH : formatNumber(check.difference, lang)}
                </Td>
                <Td>
                  {check.passed ? (
                    <Badge tone="success">
                      <CheckCircle2 className="size-3" />
                    </Badge>
                  ) : check.unavailableReason ? (
                    <Badge tone="neutral">{ar ? "تعذّر الفحص" : "Could not check"}</Badge>
                  ) : (
                    <Badge tone={check.severity === "critical" ? "danger" : "warning"}>
                      <XCircle className="size-3" />
                    </Badge>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>

        {failingQuality.length > 0 && (
          <div className="space-y-2">
            {failingQuality.map((result) => (
              <Notice
                key={result.ruleKey}
                tone={result.severity === "critical" ? "danger" : "warning"}
                title={result.ruleKey}
              >
                {result.detail}
              </Notice>
            ))}
          </div>
        )}

        {/* Warnings can be accepted by a person who states they know. Critical
            differences deliberately have no such path. */}
        {critical.length === 0 && warnings.length > 0 && !run.acceptedNote && canAccept && (
          <div className="space-y-2 rounded-md border border-warning/40 bg-warning-soft p-3">
            <p className="text-sm">
              {ar
                ? `${warnings.length} فرق غير حرج. لو ده متوقع، اكتب السبب واقبله.`
                : `${warnings.length} non-critical difference(s). If this is expected, state why and accept.`}
            </p>
            <Field
              label={ar ? "السبب" : "Reason"}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                ar ? "مثال: فواتير ملغية خارج النطاق" : "e.g. cancelled invoices out of scope"
              }
            />
            <Button size="sm" disabled={busy || note.trim().length < 3} onClick={onAccept}>
              {ar ? "اقبل واستمر" : "Accept and continue"}
            </Button>
          </div>
        )}

        {run.acceptedNote && (
          <Notice tone="neutral" title={ar ? "تم القبول" : "Accepted"}>
            {run.acceptedNote}
          </Notice>
        )}
      </CardBody>
    </Card>
  );
}
