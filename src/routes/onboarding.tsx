// Workspace onboarding page.
//
// Feature-flagged: with FEATURE_WORKSPACES off this renders an explanatory
// placeholder rather than 404ing, because a signed-in operator reaching it
// deserves to know why it is unavailable. The APIs behind it still 404.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui-bits";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/onboarding")({ component: OnboardingPage });

interface WorkspaceOption {
  id: string;
  name: string;
  onboardingState: string;
}

function OnboardingPage() {
  const { lang } = useI18n();
  const ar = lang === "ar";

  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/v1/workspaces");
        if (res.status === 404) {
          if (!cancelled) setUnavailable("disabled");
          return;
        }
        if (res.status === 401) {
          if (!cancelled) setUnavailable("signed_out");
          return;
        }
        const body = await res.json();
        if (cancelled) return;
        setWorkspaces(body.workspaces ?? []);
        setSelected(body.workspaces?.[0]?.id ?? null);
      } catch {
        if (!cancelled) setUnavailable("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title={ar ? "ربط أودو بمساحة العمل" : "Connect Odoo to your workspace"}
        subtitle={
          ar
            ? "اربط قاعدة بيانات أودو للقراءة فقط، اتأكد من الصلاحيات، واقرأ بنية بياناتك — من غير ما تكتب أي كود."
            : "Connect a read-only Odoo database, verify permissions, and read your data structure — without writing any code."
        }
      />

      {unavailable === "disabled" && (
        <Notice
          title={ar ? "الميزة غير مفعّلة" : "Feature not enabled"}
          body={
            ar
              ? "خاصية مساحات العمل متوقفة في هذه البيئة. فعّل FEATURE_WORKSPACES لتشغيلها."
              : "Workspaces are disabled in this environment. Set FEATURE_WORKSPACES to enable them."
          }
        />
      )}

      {unavailable === "signed_out" && (
        <Notice
          title={ar ? "تسجيل الدخول مطلوب" : "Sign in required"}
          body={
            ar
              ? "لازم تسجّل الدخول قبل ما تربط مساحة عمل بأودو."
              : "You need to sign in before connecting a workspace to Odoo."
          }
        />
      )}

      {unavailable === "error" && (
        <Notice
          title={ar ? "تعذر تحميل مساحات العمل" : "Could not load workspaces"}
          body={ar ? "حاول تحديث الصفحة." : "Try refreshing the page."}
        />
      )}

      {!unavailable && workspaces === null && (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-8 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>{ar ? "جاري التحميل…" : "Loading…"}</span>
        </div>
      )}

      {!unavailable && workspaces?.length === 0 && (
        <Notice
          title={ar ? "لا توجد مساحة عمل" : "No workspace yet"}
          body={
            ar
              ? "أنشئ مساحة عمل أولًا عن طريق POST /api/v1/workspaces."
              : "Create a workspace first via POST /api/v1/workspaces."
          }
        />
      )}

      {workspaces && workspaces.length > 1 && (
        <label className="block max-w-md space-y-1.5">
          <span className="text-sm font-medium">{ar ? "مساحة العمل" : "Workspace"}</span>
          <select
            value={selected ?? ""}
            onChange={(event) => setSelected(event.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected && <OnboardingWizard workspaceId={selected} />}
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-5">
      <Building2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
