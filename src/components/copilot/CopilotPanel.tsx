// The copilot panel.
//
// Every answer shows the tools that produced it. That is not a debug affordance
// — it is the difference between a number and a claim, and it is the reason a
// customer can act on what the copilot says.
import { useState } from "react";
import { Loader2, MessageSquare, ShieldCheck, ShieldAlert, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useSession, workspaceFetch } from "@/lib/session";
import { Badge, Button, Field, Notice } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

interface ToolTrailEntry {
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

interface Exchange {
  question: string;
  answer: string;
  toolTrail: ToolTrailEntry[];
  grounded: boolean;
}

export function CopilotPanel() {
  const { lang, t } = useI18n();
  const ar = lang === "ar";
  const { workspace } = useSession();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Exchange[]>([]);

  async function send() {
    if (!workspace || question.trim().length < 2) return;
    const asked = question;
    setQuestion("");
    setBusy(true);
    try {
      const response = await workspaceFetch(workspace.id, "/api/v1/copilot", {
        method: "POST",
        body: JSON.stringify({ question: asked, lang }),
      });
      const body = await response.json();
      setHistory((current) => [
        ...current,
        {
          question: asked,
          answer: response.ok
            ? body.answer
            : ar
              ? "حصلت مشكلة في الإجابة."
              : "Something went wrong answering that.",
          toolTrail: body.toolTrail ?? [],
          grounded: body.grounded !== false,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  if (!workspace) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={ar ? "افتح المساعد" : "Open the copilot"}
        // Bottom-start so it mirrors in RTL, and lifted above the mobile bar so
        // it never covers navigation.
        className="fixed bottom-20 start-4 z-40 flex size-12 items-center justify-center rounded-full bg-brand text-text-inverse shadow-lg md:bottom-6"
      >
        <MessageSquare className="size-5" />
      </button>
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex max-h-[80dvh] flex-col border-t border-border bg-surface shadow-2xl md:inset-x-auto md:bottom-6 md:start-6 md:max-h-[70dvh] md:w-[26rem] md:rounded-lg md:border">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <MessageSquare className="size-4 text-text-muted" />
        <span className="font-medium">{ar ? "المساعد" : "Copilot"}</span>
        <Badge tone="neutral">{ar ? "مقاييس معتمدة فقط" : "Approved metrics only"}</Badge>
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto"
          onClick={() => setOpen(false)}
          aria-label={t("cancel")}
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {history.length === 0 && (
          <Notice tone="neutral">
            {ar
              ? "اسأل عن أي رقم في لوحاتك. كل إجابة بتوريك المقياس والفترة اللي الرقم جه منهم."
              : "Ask about any figure on your dashboards. Every answer shows the metric and period it came from."}
          </Notice>
        )}

        {history.map((exchange, index) => (
          <div key={index} className="space-y-2">
            <p className="rounded-lg bg-surface-2 p-2.5 text-sm">{exchange.question}</p>

            <div
              className={cn(
                "rounded-lg border p-2.5 text-sm",
                exchange.grounded ? "border-border" : "border-warning/50 bg-warning-soft",
              )}
            >
              <p className="whitespace-pre-wrap">{exchange.answer}</p>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
                {exchange.grounded ? (
                  <Badge tone="success">
                    <ShieldCheck className="size-3" />
                    {ar ? "كل رقم من بياناتك" : "Every figure from your data"}
                  </Badge>
                ) : (
                  <Badge tone="warning">
                    <ShieldAlert className="size-3" />
                    {ar ? "الإجابة اتمنعت" : "Answer withheld"}
                  </Badge>
                )}
                {exchange.toolTrail.map((entry, entryIndex) => (
                  <Badge key={entryIndex} tone={entry.ok ? "neutral" : "danger"}>
                    {entry.tool}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        ))}

        {busy && (
          <p className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </p>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-border p-3">
        <div className="flex-1">
          <Field
            label=""
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={ar ? "المحصّل الشهر ده؟" : "How much did we collect this month?"}
          />
        </div>
        <Button disabled={busy || question.trim().length < 2} onClick={send}>
          {ar ? "اسأل" : "Ask"}
        </Button>
      </div>
    </div>
  );
}
