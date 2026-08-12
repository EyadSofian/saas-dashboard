// The copilot loop.
//
// The model chooses which questions to ask; the server decides what a question
// is allowed to be, executes it under the session's workspace context, and
// checks the resulting answer against what the tools actually returned.
//
// Without an API key the copilot still works: a deterministic path matches the
// question to metrics, runs them, and renders the values without narration.
// That is not a degraded mode so much as a floor — the numbers are identical
// either way, because both paths call the same tools.
import type { WorkspaceContext } from "../contracts";
import { runTool, TOOL_DEFINITIONS, type ToolCall, type ToolResult } from "./tools";
import { groundingRefusal, verifyGrounded } from "./grounding";
import { metricMap } from "../metrics/packs";
import { suggestDashboard } from "../dashboards/nl-builder";

const MAX_TOOL_ROUNDS = 4;

const SYSTEM_PROMPT = `You answer questions about a company's Odoo data using only the tools provided.

Rules:
1. Every number in your answer MUST come from a tool result. Never estimate, never extrapolate, never carry a figure over from your own knowledge. An answer containing an unsourced number is rejected before the user sees it.
2. If a metric is unavailable, say so plainly and say why. Do not substitute a similar metric without stating that you did.
3. Always state the period the numbers cover and the date basis they use.
4. A null or unavailable value means "not measurable", never zero. Say "not available", not "0".
5. Do not claim causation. You may report that two figures moved together; you may not say one caused the other.
6. Answer in the language the user asked in. Keep it short — an owner reads three sentences, not three paragraphs.

You cannot write SQL, read individual records, or see any workspace other than the one you are serving.`;

export interface CopilotAnswer {
  answer: string;
  toolTrail: Array<{ call: ToolCall; result: ToolResult }>;
  groundingError: string | null;
  usedModel: string | null;
  latencyMs: number;
}

export interface AskOptions {
  question: string;
  lang: "ar" | "en";
  /** Injected in tests, and the seam a different provider would use. */
  complete?: (input: {
    system: string;
    messages: Array<{ role: string; content: string }>;
    tools: typeof TOOL_DEFINITIONS;
  }) => Promise<{ toolCalls?: ToolCall[]; content?: string }>;
  apiKey?: string;
  model?: string;
}

/** Half-open [from, to): today is included exactly once. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(now.getTime() + 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/**
 * The no-model path.
 *
 * Reuses the dashboard builder's metric matcher, so "collected cash this month"
 * resolves the same way whether it is building a widget or answering a
 * question. The reply is a plain rendering of tool output — no narration, and
 * therefore nothing to hallucinate.
 */
async function answerDeterministically(
  context: WorkspaceContext,
  options: AskOptions,
): Promise<CopilotAnswer> {
  const started = Date.now();
  const known = metricMap();
  const listed = await runTool(context, { name: "list_metrics", arguments: {} });
  const available = new Set(
    (listed.data as Array<{ key: string }> | null)?.map((entry) => entry.key) ?? [],
  );

  const match = suggestDashboard({ request: options.question, known, available });
  const trail: Array<{ call: ToolCall; result: ToolResult }> = [
    { call: { name: "list_metrics", arguments: {} }, result: listed },
  ];

  if (!match.matchedMetrics.length) {
    const ar = options.lang === "ar";
    const names = [...available]
      .slice(0, 8)
      .map((key) => (ar ? known.get(key)?.label.ar : known.get(key)?.label.en))
      .filter(Boolean)
      .join("، ");
    return {
      answer: ar
        ? `مفهمتش أنهي مقياس تقصده. المتاح دلوقتي: ${names || "لا شيء بعد"}.`
        : `I could not tell which metric you meant. Available right now: ${names || "nothing yet"}.`,
      toolTrail: trail,
      groundingError: null,
      usedModel: null,
      latencyMs: Date.now() - started,
    };
  }

  const range = defaultRange();
  const call: ToolCall = {
    name: "query_metric",
    arguments: { metricKeys: match.matchedMetrics, from: range.from, to: range.to },
  };
  const result = await runTool(context, call);
  trail.push({ call, result });

  const values = (result.data as { values?: Array<Record<string, unknown>> } | null)?.values ?? [];
  const ar = options.lang === "ar";

  const lines = values.map((value) => {
    const metric = known.get(String(value.metricKey));
    const label = ar ? metric?.label.ar : metric?.label.en;
    // Unavailable is stated as unavailable. Rendering it as 0 is the specific
    // failure this product exists to avoid.
    const rendered =
      value.value === null ? (ar ? "غير متاح" : "not available") : String(value.value);
    return `• ${label ?? value.metricKey}: ${rendered}`;
  });

  return {
    answer:
      (ar
        ? `للفترة من ${range.from} إلى ${range.to} (نهاية غير شاملة):\n`
        : `For ${range.from} to ${range.to} (end exclusive):\n`) + lines.join("\n"),
    toolTrail: trail,
    groundingError: null,
    usedModel: null,
    latencyMs: Date.now() - started,
  };
}

export async function ask(context: WorkspaceContext, options: AskOptions): Promise<CopilotAnswer> {
  const complete = options.complete ?? (await openAiCompleter(options));
  if (!complete) return answerDeterministically(context, options);

  const started = Date.now();
  const trail: Array<{ call: ToolCall; result: ToolResult }> = [];
  const messages: Array<{ role: string; content: string }> = [
    { role: "user", content: options.question },
  ];

  let answer = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let step: { toolCalls?: ToolCall[]; content?: string };
    try {
      step = await complete({ system: SYSTEM_PROMPT, messages, tools: TOOL_DEFINITIONS });
    } catch {
      // A provider outage falls back to the deterministic path rather than
      // failing: the customer still gets their number.
      return answerDeterministically(context, options);
    }

    if (step.toolCalls?.length) {
      for (const call of step.toolCalls) {
        // Executed with the server's context. The model names a tool and its
        // arguments; it never supplies a workspace.
        const result = await runTool(context, call);
        trail.push({ call, result });
        messages.push({
          role: "assistant",
          content: `TOOL ${call.name} → ${JSON.stringify(result.data ?? result.error)}`,
        });
      }
      continue;
    }

    answer = step.content ?? "";
    break;
  }

  if (!answer.trim()) {
    return answerDeterministically(context, options);
  }

  // The control. Every figure in the answer must trace to a tool result.
  const grounded = trail.flatMap((entry) => entry.result.numbers);
  const verification = verifyGrounded(answer, grounded);

  if (!verification.grounded) {
    return {
      answer: groundingRefusal(options.lang),
      toolTrail: trail,
      groundingError: `Ungrounded figures: ${verification.issues
        .map((issue) => issue.value)
        .join(", ")}`,
      usedModel: options.model ?? "gpt-4o-mini",
      latencyMs: Date.now() - started,
    };
  }

  return {
    answer,
    toolTrail: trail,
    groundingError: null,
    usedModel: options.model ?? "gpt-4o-mini",
    latencyMs: Date.now() - started,
  };
}

/** Builds an OpenAI-backed completer, or null when no key is configured. */
async function openAiCompleter(options: AskOptions): Promise<AskOptions["complete"] | null> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  const model = options.model ?? "gpt-4o-mini";
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  return async ({ system, messages, tools }) => {
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        ...messages.map((message) => ({
          role: message.role === "user" ? ("user" as const) : ("assistant" as const),
          content: message.content,
        })),
      ],
      tools: tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    });

    const choice = response.choices[0]?.message;
    const toolCalls = choice?.tool_calls
      ?.map((call) => {
        if (call.type !== "function") return null;
        try {
          return {
            name: call.function.name,
            arguments: JSON.parse(call.function.arguments || "{}"),
          };
        } catch {
          return null;
        }
      })
      .filter((call): call is ToolCall => call !== null);

    return { toolCalls, content: choice?.content ?? undefined };
  };
}
