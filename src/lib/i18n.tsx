// Arabic/English with real RTL.
//
// Arabic is a first-class product language here, not a translation pass: the
// copy is written in Arabic rather than translated from English, the document
// direction flips, and technical values (URLs, Odoo model names, hashes) stay
// LTR inside an RTL sentence — which is what `<Ltr>` is for.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Lang = "ar" | "en";
export type Theme = "light" | "dark";

type Entry = { ar: string; en: string };

export const DICT = {
  // Product
  app_name: { ar: "إنسايت أو إس", en: "InsightOS" },
  app_tagline: {
    ar: "تحليلات أودو تفهم شغلك",
    en: "Odoo analytics that understands your business",
  },

  // Navigation
  nav_overview: { ar: "نظرة عامة", en: "Overview" },
  nav_dashboards: { ar: "اللوحات", en: "Dashboards" },
  nav_onboarding: { ar: "ربط أودو", en: "Connect Odoo" },
  nav_mapping: { ar: "خريطة البيانات", en: "Data mapping" },
  nav_data_health: { ar: "صحة البيانات", en: "Data health" },
  nav_settings: { ar: "الإعدادات", en: "Settings" },
  nav_members: { ar: "الأعضاء", en: "Members" },

  // Auth
  auth_sign_in: { ar: "تسجيل الدخول", en: "Sign in" },
  auth_sign_up: { ar: "إنشاء حساب", en: "Create account" },
  auth_sign_out: { ar: "تسجيل الخروج", en: "Sign out" },
  auth_email: { ar: "البريد الإلكتروني", en: "Email" },
  auth_password: { ar: "كلمة المرور", en: "Password" },
  auth_name: { ar: "الاسم", en: "Name" },
  auth_no_account: { ar: "معندكش حساب؟", en: "No account yet?" },
  auth_have_account: { ar: "عندك حساب؟", en: "Already have an account?" },
  auth_failed: { ar: "بيانات الدخول غير صحيحة.", en: "Those credentials are not correct." },

  // Workspace
  workspace: { ar: "مساحة العمل", en: "Workspace" },
  workspace_create: { ar: "إنشاء مساحة عمل", en: "Create workspace" },
  organization: { ar: "المؤسسة", en: "Organization" },
  workspace_none: { ar: "لا توجد مساحة عمل بعد", en: "No workspace yet" },

  // Onboarding
  onboarding_title: { ar: "اربط أودو بمساحة العمل", en: "Connect Odoo to your workspace" },
  onboarding_step_connection: { ar: "الاتصال", en: "Connection" },
  onboarding_step_permissions: { ar: "الصلاحيات", en: "Permissions" },
  onboarding_step_discovery: { ar: "قراءة البنية", en: "Discovery" },
  onboarding_step_mapping: { ar: "المراجعة والاعتماد", en: "Review & approve" },
  odoo_url: { ar: "رابط أودو", en: "Odoo URL" },
  odoo_database: { ar: "اسم قاعدة البيانات", en: "Database name" },
  odoo_login: { ar: "اسم المستخدم", en: "Login" },
  odoo_api_key: { ar: "مفتاح الـ API", en: "API key" },
  odoo_read_only_hint: {
    ar: "استخدم مستخدم أودو للقراءة فقط. المنصة لا تكتب في أودو إطلاقًا.",
    en: "Use a read-only Odoo user. The platform never writes to Odoo.",
  },
  odoo_key_stored: {
    ar: "محفوظ ومشفّر. اكتب مفتاحًا جديدًا فقط لو عايز تغيّره.",
    en: "Stored and encrypted. Enter a new key only to replace it.",
  },
  odoo_key_new: {
    ar: "بيتحفظ مشفّرًا ومش بيرجع للمتصفح تاني أبدًا.",
    en: "Stored encrypted and never returned to the browser.",
  },

  // Actions
  save: { ar: "حفظ", en: "Save" },
  test_connection: { ar: "اختبار الاتصال", en: "Test connection" },
  start_discovery: { ar: "ابدأ قراءة البنية", en: "Start discovery" },
  approve: { ar: "اعتماد", en: "Approve" },
  reject: { ar: "رفض", en: "Reject" },
  edit: { ar: "تعديل", en: "Edit" },
  retry: { ar: "إعادة المحاولة", en: "Retry" },
  cancel: { ar: "إلغاء", en: "Cancel" },
  publish: { ar: "نشر", en: "Publish" },

  // Mapping
  mapping_title: { ar: "خريطة المفاهيم", en: "Concept mapping" },
  mapping_concept: { ar: "المفهوم", en: "Concept" },
  mapping_source: { ar: "المصدر في أودو", en: "Odoo source" },
  mapping_confidence: { ar: "الثقة", en: "Confidence" },
  mapping_evidence: { ar: "الدليل", en: "Evidence" },
  mapping_needs_review: { ar: "محتاج مراجعة", en: "Needs review" },
  mapping_approved: { ar: "معتمد", en: "Approved" },
  mapping_unresolved: { ar: "غير محسوم", en: "Unresolved" },
  mapping_financial_warning: {
    ar: "ده تعريف مالي — لازم اعتماد صريح مهما كانت نسبة الثقة.",
    en: "This is a financial definition — it needs explicit approval whatever the confidence.",
  },

  // States
  loading: { ar: "جاري التحميل…", en: "Loading…" },
  unavailable: { ar: "غير متاح", en: "Not available" },
  never_synced: { ar: "لم تتم المزامنة بعد", en: "Never synced" },
  last_good: { ar: "آخر نسخة ناجحة", en: "Last good" },
  stale: { ar: "قديمة", en: "Stale" },
  failed: { ar: "فشلت", en: "Failed" },
  success: { ar: "ناجحة", en: "Success" },

  // Explainability
  how_calculated: { ar: "إزاي اتحسب ده؟", en: "How is this calculated?" },
  formula: { ar: "المعادلة", en: "Formula" },
  date_basis: { ar: "أساس التاريخ", en: "Date basis" },
  source: { ar: "المصدر", en: "Source" },
  coverage: { ar: "التغطية", en: "Coverage" },
  last_sync: { ar: "آخر مزامنة ناجحة", en: "Last successful sync" },
  mapping_version: { ar: "إصدار الخريطة", en: "Mapping version" },
  why_dash: {
    ar: "الشرطة معناها إن الرقم غير متاح — مش صفر.",
    en: "A dash means the value is unavailable — not zero.",
  },
} satisfies Record<string, Entry>;

export type DictKey = keyof typeof DICT;

interface I18nValue {
  lang: Lang;
  dir: "rtl" | "ltr";
  theme: Theme;
  t: (key: DictKey) => string;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const I18nContext = createContext<I18nValue | null>(null);

const STORAGE_LANG = "insightos.lang";
const STORAGE_THEME = "insightos.theme";

export function I18nProvider({ children }: { children: ReactNode }) {
  // Arabic is the default because the first market is Arabic-speaking; English
  // is the switch, not the baseline.
  const [lang, setLangState] = useState<Lang>("ar");
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    const storedLang = localStorage.getItem(STORAGE_LANG);
    if (storedLang === "ar" || storedLang === "en") setLangState(storedLang);
    const storedTheme = localStorage.getItem(STORAGE_THEME);
    if (storedTheme === "light" || storedTheme === "dark") setThemeState(storedTheme);
  }, []);

  const dir = lang === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    // Direction lives on <html> so Tailwind's logical properties, scrollbars and
    // native form controls all mirror — not just the components we remembered.
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [lang, dir, theme]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    localStorage.setItem(STORAGE_LANG, next);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    localStorage.setItem(STORAGE_THEME, next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      dir,
      theme,
      t: (key) => DICT[key][lang],
      setLang,
      toggleLang: () => setLang(lang === "ar" ? "en" : "ar"),
      setTheme,
      toggleTheme: () => setTheme(theme === "light" ? "dark" : "light"),
    }),
    [lang, dir, theme, setLang, setTheme],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used within I18nProvider");
  return context;
}

/**
 * Forces LTR for a technical value inside Arabic text.
 *
 * Without this, a URL or an Odoo model name inside an RTL paragraph renders
 * with its punctuation reordered — `crm.lead` can display as `lead.crm`.
 */
export function Ltr({ children }: { children: ReactNode }) {
  return (
    <span dir="ltr" className="inline-block">
      {children}
    </span>
  );
}

/** Locale-aware number formatting; Arabic uses Western digits by product choice. */
export function formatNumber(value: number | null, lang: Lang, options?: Intl.NumberFormatOptions) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(lang === "ar" ? "ar-EG-u-nu-latn" : "en-US", options).format(value);
}

export function formatCurrency(value: number | null, currency: string, lang: Lang) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(lang === "ar" ? "ar-EG-u-nu-latn" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

/** A null metric always renders as an em dash — never 0, NaN or Infinity. */
export const DASH = "—";
