import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Clock, XCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useSession, workspaceFetch } from "@/lib/session";
import {
  Badge,
  Card,
  CardBody,
  DataTable,
  Notice,
  PageHeader,
  Skeleton,
  Td,
  Th,
} from "@/components/ui/primitives";

export const Route = createFileRoute("/data-health")({ component: DataHealthPage });

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
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const response = await workspaceFetch(workspace.id, "/api/v1/data-health");
      if (response.ok) setDomains((await response.json()).domains ?? []);
    } finally {
      setLoading(false);
    }
  }, [workspace]);

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
