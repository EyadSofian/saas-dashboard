import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Button, Field, Notice } from "@/components/ui/primitives";
import { AuthLayout } from "./sign-in";

export const Route = createFileRoute("/sign-up")({ component: SignUpPage });

function SignUpPage() {
  const { t, lang, toggleLang } = useI18n();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(
          typeof body?.message === "string"
            ? body.message
            : lang === "ar"
              ? "تعذر إنشاء الحساب."
              : "Could not create the account.",
        );
        return;
      }
      // A brand-new account has no workspace yet, so send them straight to
      // creating one rather than to an empty overview.
      await navigate({ to: "/workspaces/new" });
      window.location.reload();
    } catch {
      setError(lang === "ar" ? "تعذر إنشاء الحساب." : "Could not create the account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t("auth_sign_up")}
      footer={
        <>
          {t("auth_have_account")}{" "}
          <Link to="/sign-in" className="font-medium text-brand-ink hover:underline">
            {t("auth_sign_in")}
          </Link>
        </>
      }
      onToggleLang={toggleLang}
      langLabel={lang === "ar" ? "English" : "العربية"}
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field
          label={t("auth_name")}
          required
          autoComplete="name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Field
          label={t("auth_email")}
          type="email"
          required
          autoComplete="email"
          ltr
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <Field
          label={t("auth_password")}
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          ltr
          hint={lang === "ar" ? "٨ أحرف على الأقل" : "At least 8 characters"}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <Button type="submit" disabled={busy} className="w-full">
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t("auth_sign_up")}
        </Button>
      </form>
    </AuthLayout>
  );
}
