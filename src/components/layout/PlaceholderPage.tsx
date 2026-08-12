// Temporary: replaced by the real page in the milestone that builds it.
import { useI18n } from "@/lib/i18n";
import { Notice, PageHeader } from "@/components/ui/primitives";

const COPY: Record<string, { ar: string; en: string; titleAr: string; titleEn: string }> = {
  mapping: {
    titleAr: "خريطة المفاهيم",
    titleEn: "Concept mapping",
    ar: "الصفحة دي بتتبني في المرحلة الجاية.",
    en: "This page is built in the next milestone.",
  },
  dashboards: {
    titleAr: "اللوحات",
    titleEn: "Dashboards",
    ar: "الصفحة دي بتتبني في المرحلة الجاية.",
    en: "This page is built in the next milestone.",
  },
  "data-health": {
    titleAr: "صحة البيانات",
    titleEn: "Data health",
    ar: "الصفحة دي بتتبني في المرحلة الجاية.",
    en: "This page is built in the next milestone.",
  },
};

export function PlaceholderPage({ page }: { page: string }) {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const copy = COPY[page];
  return (
    <div className="space-y-6">
      <PageHeader title={ar ? copy.titleAr : copy.titleEn} />
      <Notice tone="neutral">{ar ? copy.ar : copy.en}</Notice>
    </div>
  );
}
