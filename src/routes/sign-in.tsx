import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Gauge, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Button, Card, CardBody, Field, Notice } from "@/components/ui/primitives";

export const Route = createFileRoute("/sign-in")({ component: SignInPage });

function SignInPage() {
  const { t, lang, toggleLang } = useI18n();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!response.ok) {
        // Deliberately the same message for "no such user" and "wrong
        // password": distinguishing them turns the form into an account oracle.
        setError(t("auth_failed"));
        return;
      }
      await navigate({ to: "/" });
      window.location.reload();
    } catch {
      setError(t("auth_failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t("auth_sign_in")}
      footer={
        <>
          {t("auth_no_account")}{" "}
          <Link to="/sign-up" className="font-medium text-brand-ink hover:underline">
            {t("auth_sign_up")}
          </Link>
        </>
      }
      onToggleLang={toggleLang}
      langLabel={lang === "ar" ? "English" : "العربية"}
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
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
          autoComplete="current-password"
          ltr
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <Button type="submit" disabled={busy} className="w-full">
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t("auth_sign_in")}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function AuthLayout({
  title,
  children,
  footer,
  onToggleLang,
  langLabel,
}: {
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  onToggleLang: () => void;
  langLabel: string;
}) {
  const { t } = useI18n();
  return (
    <div className="grid min-h-dvh place-items-center bg-bg p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <span className="grid size-8 place-items-center rounded-md bg-brand text-text-inverse">
              <Gauge className="size-4" />
            </span>
            {t("app_name")}
          </div>
          <Button variant="ghost" size="sm" onClick={onToggleLang}>
            {langLabel}
          </Button>
        </div>

        <p className="text-sm text-text-muted">{t("app_tagline")}</p>

        <Card>
          <CardBody className="space-y-4">
            <h1 className="text-lg font-semibold">{title}</h1>
            {children}
          </CardBody>
        </Card>

        <p className="text-center text-sm text-text-muted">{footer}</p>
      </div>
    </div>
  );
}
