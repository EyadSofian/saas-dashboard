// Grounding: every number in an answer must have come from a tool.
//
// The roadmap's exit criterion for the copilot is that it cannot produce a
// number the dashboard would not. A system prompt asking a model not to invent
// figures is a request, not a control. This is the control: the draft answer is
// scanned for numbers, and any figure that does not match a tool result means
// the answer is refused rather than shown.
//
// Refusing is the right failure. A copilot that occasionally invents a revenue
// total is worse than no copilot, because the invented one is indistinguishable
// from the real ones.

/** Numbers that carry no claim about the business and need no grounding. */
const SAFE_PATTERNS: RegExp[] = [
  // Dates and times: 2026-03-01, 09:30, Q1, 2026
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}:\d{2}\b/g,
  /\bq[1-4]\b/gi,
  /\b(19|20)\d{2}\b/g,
  // Small enumerations in prose: "the 3 metrics below".
  //
  // The lookarounds are essential. `\b[0-9]\b` would match the leading "4" of
  // "4,200" — a comma is a word boundary — masking it and turning a figure of
  // 4,200 into 200, which could then coincidentally match a real value and let
  // an invented number through.
  /(?<![\d.,])[0-9](?![\d.,])/g,
];

export interface GroundingIssue {
  value: number;
  context: string;
}

export interface GroundingResult {
  grounded: boolean;
  issues: GroundingIssue[];
}

/**
 * Extracts candidate business figures from an answer.
 *
 * Deliberately generous about what counts as a number and conservative about
 * what it excuses: a false positive costs a regenerated answer, while a false
 * negative puts an invented figure in front of an owner.
 */
export function extractNumbers(text: string): Array<{ value: number; context: string }> {
  let masked = text;
  for (const pattern of SAFE_PATTERNS)
    masked = masked.replace(pattern, (m) => " ".repeat(m.length));

  const found: Array<{ value: number; context: string }> = [];
  // Matches 1,234.56 / 1234 / 12.5 — with or without thousands separators.
  const NUMBER = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

  for (const match of masked.matchAll(NUMBER)) {
    const value = Number(match[0].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const start = Math.max(0, (match.index ?? 0) - 25);
    found.push({ value, context: text.slice(start, (match.index ?? 0) + match[0].length + 25) });
  }
  return found;
}

/**
 * Whether a stated figure matches something a tool returned.
 *
 * Tolerant of presentation: a model may round 12,499.62 to 12,500 or express a
 * ratio as a percentage. Both are honest renderings of a real value, so they
 * are accepted; a figure with no plausible source is not.
 */
function matchesGrounded(value: number, grounded: number[]): boolean {
  for (const source of grounded) {
    if (value === source) return true;

    // Rounding for display: within 1% or within 1 unit, whichever is looser.
    const tolerance = Math.max(Math.abs(source) * 0.01, 1);
    if (Math.abs(value - source) <= tolerance) return true;

    // A ratio quoted as a percentage, or vice versa.
    if (Math.abs(value - source * 100) <= Math.max(Math.abs(source * 100) * 0.01, 1)) return true;
    if (Math.abs(value * 100 - source) <= Math.max(Math.abs(source) * 0.01, 1)) return true;

    // Thousands/millions shorthand: "1.2 million" against 1,200,000.
    for (const scale of [1_000, 1_000_000]) {
      if (Math.abs(value * scale - source) <= Math.abs(source) * 0.01) return true;
    }
  }
  return false;
}

export function verifyGrounded(answer: string, grounded: number[]): GroundingResult {
  const issues: GroundingIssue[] = [];

  for (const candidate of extractNumbers(answer)) {
    if (!matchesGrounded(candidate.value, grounded)) {
      issues.push({ value: candidate.value, context: candidate.context.trim() });
    }
  }

  return { grounded: issues.length === 0, issues };
}

/**
 * What the customer sees when grounding fails.
 *
 * Says plainly that the answer was withheld rather than substituting a vaguer
 * one — a hedged paragraph would hide that the system caught itself.
 */
export function groundingRefusal(lang: "ar" | "en"): string {
  return lang === "ar"
    ? "مقدرتش أجاوب على ده باطمئنان. الإجابة اللي طلعت كان فيها رقم مش راجع من بيانات مساحة العمل، فمنعتها بدل ما أعرضه. جرّب تسأل بصيغة أوضح، أو افتح اللوحة مباشرة."
    : "I could not answer that safely. The draft answer contained a figure that did not come from your workspace's data, so it was withheld rather than shown. Try asking more specifically, or open the dashboard directly.";
}
