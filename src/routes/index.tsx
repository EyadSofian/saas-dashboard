import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Database,
  Gauge,
  Route as RouteIcon,
  ShieldCheck,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { Badge, Button, Card, CardBody, Notice, PageHeader } from "@/components/ui/primitives";

export const Route = createFileRoute("/")({ component: OverviewPage });

/** Where a workspace is in its journey, and what it should do next. */
const NEXT_STEP: Record<
  string,
  { to: string; ar: string; en: string; labelAr: string; labelEn: string }
> = {
  draft: {
    to: "/onboarding",
    ar: "اربط قاعدة بيانات أودو للقراءة فقط عشان نبدأ.",
    en: "Connect a read-only Odoo database to get started.",
    labelAr: "ابدأ الربط",
    labelEn: "Start connecting",
  },
  connection_pending: {
    to: "/onboarding",
    ar: "بيانات الاتصال محفوظة. فاضل نتأكد من الصلاحيات.",
    en: "Connection saved. Next, verify the read permissions.",
    labelAr: "اختبر الاتصال",
    labelEn: "Test connection",
  },
  validating: {
    to: "/onboarding",
    ar: "الصلاحيات اتأكدت. ابدأ قراءة بنية البيانات.",
    en: "Permissions verified. Start reading the data structure.",
    labelAr: "ابدأ القراءة",
    labelEn: "Start discovery",
  },
  permission_failed: {
    to: "/onboarding",
    ar: "المستخدم مش شايف كل الموديلات المطلوبة. راجع الصلاحيات في أودو.",
    en: "The user cannot read every required model. Review the Odoo permissions.",
    labelAr: "راجع الصلاحيات",
    labelEn: "Review permissions",
  },
  discovering: {
    to: "/onboarding",
    ar: "جاري قراءة بنية بياناتك.",
    en: "Reading your data structure.",
    labelAr: "عرض التقدم",
    labelEn: "View progress",
  },
  snapshot_ready: {
    to: "/mapping",
    ar: "قرينا بنية بياناتك. دلوقتي راجع واعتمد معاني الحقول.",
    en: "Your structure is read. Now review and approve what each field means.",
    labelAr: "راجع الخريطة",
    labelEn: "Review mapping",
  },
  mapping_review: {
    to: "/mapping",
    ar: "فيه مفاهيم لسه محتاجة اعتماد قبل ما نطلع أرقام.",
    en: "Some concepts still need approval before any number is produced.",
    labelAr: "أكمل المراجعة",
    labelEn: "Continue review",
  },
  published: {
    to: "/dashboards",
    ar: "الخريطة معتمدة. اللوحات جاهزة.",
    en: "The mapping is approved. Your dashboards are ready.",
    labelAr: "افتح اللوحات",
    labelEn: "Open dashboards",
  },
  failed: {
    to: "/onboarding",
    ar: "آخر محاولة فشلت. تقدر تعيدها من صفحة الربط.",
    en: "The last attempt failed. You can retry it from the connection page.",
    labelAr: "إعادة المحاولة",
    labelEn: "Retry",
  },
};

function OverviewPage() {
  const { lang, t } = useI18n();
  const ar = lang === "ar";
  const { user, workspace, workspaces } = useSession();
  const Arrow = ar ? ArrowLeft : ArrowRight;

  if (!user) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <h1 className="text-xl font-semibold">{t("app_name")}</h1>
        <p className="text-sm text-text-muted">{t("app_tagline")}</p>
        <Link to="/sign-in">
          <Button>{t("auth_sign_in")}</Button>
        </Link>
      </div>
    );
  }

  if (!workspaces.length || !workspace) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <h1 className="text-lg font-semibold">{t("workspace_none")}</h1>
        <p className="text-sm text-text-muted">
          {ar
            ? "أنشئ مساحة عمل عشان تبدأ تربط أودو."
            : "Create a workspace to start connecting Odoo."}
        </p>
        <Link to="/workspaces/new">
          <Button>{t("workspace_create")}</Button>
        </Link>
      </div>
    );
  }

  const step = NEXT_STEP[workspace.onboardingState] ?? NEXT_STEP.draft;

  return (
    <div className="space-y-6">
      <PageHeader
        title={workspace.name}
        subtitle={
          ar
            ? "كل رقم هنا هيقدر يشرح مصدره ومعادلته وسياسة تاريخه."
            : "Every number here can explain its source, formula and date policy."
        }
        actions={<Badge tone="brand">{workspace.baseCurrency}</Badge>}
      />

      {/* The whole product before publication is one question: what is next? */}
      <Notice
        tone="brand"
        icon={<Gauge className="size-4" />}
        title={ar ? "الخطوة التالية" : "Next step"}
      >
        <p className="mt-1">{ar ? step.ar : step.en}</p>
        <Link to={step.to} className="mt-3 inline-block">
          <Button size="sm">
            {ar ? step.labelAr : step.labelEn}
            <Arrow className="size-3.5" />
          </Button>
        </Link>
      </Notice>

      <div className="grid gap-4 sm:grid-cols-3">
        <JourneyCard
          icon={<Database className="size-4" />}
          title={t("nav_onboarding")}
          body={
            ar
              ? "اتصال للقراءة فقط، مفتاح مشفّر، وفحص صلاحيات لكل موديل."
              : "Read-only connection, encrypted key, and a per-model permission check."
          }
          done={
            workspace.onboardingState !== "draft" &&
            workspace.onboardingState !== "connection_pending"
          }
        />
        <JourneyCard
          icon={<RouteIcon className="size-4" />}
          title={t("nav_mapping")}
          body={
            ar
              ? "الذكاء الاصطناعي يقترح، وانت تعتمد. التعريفات المالية لازم اعتماد صريح."
              : "AI proposes, you approve. Financial definitions always need explicit approval."
          }
          done={workspace.onboardingState === "published"}
        />
        <JourneyCard
          icon={<ShieldCheck className="size-4" />}
          title={t("nav_dashboards")}
          body={
            ar
              ? "لوحات تتبني من الخريطة المعتمدة، مش من كود مكتوب لكل عميل."
              : "Dashboards built from the approved mapping, not code written per customer."
          }
          done={workspace.onboardingState === "published"}
        />
      </div>
    </div>
  );
}

function JourneyCard({
  icon,
  title,
  body,
  done,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  done: boolean;
}) {
  const { lang } = useI18n();
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 font-medium">
            {icon}
            {title}
          </span>
          {done && <Badge tone="success">{lang === "ar" ? "تم" : "Done"}</Badge>}
        </div>
        <p className="text-sm text-text-muted">{body}</p>
      </CardBody>
    </Card>
  );
}
