import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Notice,
  PageHeader,
  SelectField,
} from "@/components/ui/primitives";

export const Route = createFileRoute("/workspaces/new")({ component: NewWorkspacePage });

// Timezones and currencies are offered as a short, editable list rather than an
// exhaustive dropdown: the first market is Gulf/Egypt, and a 400-entry select is
// worse for everyone than five relevant options plus free text.
const TIMEZONES = [
  "Africa/Cairo",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Kuwait",
  "Europe/Istanbul",
  "UTC",
];
const CURRENCIES = ["USD", "EGP", "SAR", "AED", "KWD", "EUR"];
const INDUSTRIES = [
  { key: "general_b2b", ar: "مبيعات B2B عامة", en: "General B2B sales" },
  { key: "education", ar: "تعليم وتدريب", en: "Education & training" },
  { key: "professional_services", ar: "خدمات مهنية", en: "Professional services" },
  { key: "retail", ar: "تجزئة وتجارة إلكترونية", en: "Retail & e-commerce" },
  { key: "construction", ar: "مقاولات ومشاريع", en: "Construction & projects" },
];

function NewWorkspacePage() {
  const { lang, t } = useI18n();
  const ar = lang === "ar";
  const navigate = useNavigate();
  const { refresh } = useSession();

  const [form, setForm] = useState({
    organizationName: "",
    workspaceName: "",
    timezone: "Africa/Cairo",
    locale: ar ? "ar-EG" : "en-US",
    baseCurrency: "USD",
    industryPack: "general_b2b",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(
          body.error ?? (ar ? "تعذر إنشاء مساحة العمل." : "Could not create the workspace."),
        );
        return;
      }
      await refresh();
      await navigate({ to: "/onboarding" });
    } catch {
      setError(ar ? "تعذر الاتصال بالخادم." : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={t("workspace_create")}
        subtitle={
          ar
            ? "مساحة العمل هي بيئة تحليلية معزولة. بياناتها لا تختلط ببيانات أي مساحة أخرى."
            : "A workspace is an isolated analytics environment. Its data never mixes with any other workspace."
        }
      />

      <Card>
        <CardHeader
          icon={<Building2 className="size-4" />}
          title={ar ? "بيانات المؤسسة" : "Organization details"}
        />
        <CardBody>
          <form onSubmit={submit} className="space-y-4">
            {error && <Notice tone="danger">{error}</Notice>}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("organization")}
                required
                maxLength={200}
                value={form.organizationName}
                onChange={(e) => setForm({ ...form, organizationName: e.target.value })}
                hint={ar ? "اسم الشركة كما تريده في الفواتير" : "Your company name"}
              />
              <Field
                label={t("workspace")}
                required
                maxLength={200}
                value={form.workspaceName}
                onChange={(e) => setForm({ ...form, workspaceName: e.target.value })}
                hint={ar ? "مثال: الإنتاج" : "For example: Production"}
              />

              <SelectField
                label={ar ? "المنطقة الزمنية" : "Timezone"}
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                hint={
                  ar
                    ? "كل التواريخ في التقارير هتتحسب بالمنطقة دي."
                    : "Every reporting date is computed in this timezone."
                }
              >
                {TIMEZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </SelectField>

              <SelectField
                label={ar ? "العملة الأساسية" : "Base currency"}
                value={form.baseCurrency}
                onChange={(e) => setForm({ ...form, baseCurrency: e.target.value })}
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </SelectField>

              <SelectField
                label={ar ? "اللغة" : "Language"}
                value={form.locale}
                onChange={(e) => setForm({ ...form, locale: e.target.value })}
              >
                <option value="ar-EG">العربية (مصر)</option>
                <option value="ar-SA">العربية (السعودية)</option>
                <option value="en-US">English</option>
              </SelectField>

              <SelectField
                label={ar ? "طبيعة النشاط" : "Industry"}
                value={form.industryPack}
                onChange={(e) => setForm({ ...form, industryPack: e.target.value })}
                hint={
                  ar
                    ? "بتحدد المقاييس المقترحة في البداية — وتقدر تغيّرها بعدين."
                    : "Decides which metrics are proposed first — changeable later."
                }
              >
                {INDUSTRIES.map((industry) => (
                  <option key={industry.key} value={industry.key}>
                    {ar ? industry.ar : industry.en}
                  </option>
                ))}
              </SelectField>
            </div>

            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t("workspace_create")}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
