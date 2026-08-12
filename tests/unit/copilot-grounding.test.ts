// Grounding: the control behind "the copilot cannot produce a number the
// dashboard would not".
//
// A system prompt asking a model not to invent figures is a request. These
// tests cover the thing that actually enforces it.
import { describe, expect, it } from "vitest";
import { extractNumbers, groundingRefusal, verifyGrounded } from "@/platform/copilot/grounding";

describe("number extraction", () => {
  it("finds business figures", () => {
    const found = extractNumbers("Collected revenue was 12,500 and invoiced 18,300.");
    expect(found.map((entry) => entry.value)).toEqual([12_500, 18_300]);
  });

  it("ignores dates, years and clock times", () => {
    // These carry no claim about the business, so requiring a tool source for
    // them would reject every honest answer.
    const found = extractNumbers("Between 2026-03-01 and 2026-04-01, as of 09:30 in Q1 2026.");
    expect(found).toEqual([]);
  });

  it("ignores small counts used in prose", () => {
    expect(extractNumbers("Here are the 3 metrics you asked about.")).toEqual([]);
  });

  it("keeps decimals and negatives", () => {
    const found = extractNumbers("Margin fell by -1250.75 this month.");
    expect(found[0].value).toBe(-1250.75);
  });
});

describe("verification", () => {
  it("passes an answer whose figures all came from tools", () => {
    const result = verifyGrounded("Collected was 12,500 and invoiced 18,300.", [12_500, 18_300]);
    expect(result.grounded).toBe(true);
  });

  it("catches an invented figure", () => {
    // The exact failure mode this exists for: two real numbers and one the
    // model produced on its own.
    const result = verifyGrounded(
      "Collected was 12,500, invoiced 18,300, and margin was 4,200.",
      [12_500, 18_300],
    );
    expect(result.grounded).toBe(false);
    expect(result.issues.map((issue) => issue.value)).toEqual([4_200]);
  });

  it("catches an extrapolation the model made from real numbers", () => {
    // 12,500 and 18,300 are real; their difference is arithmetic the model did
    // itself, and arithmetic is exactly where a copilot goes wrong quietly.
    const result = verifyGrounded("The gap between them is 5,800.", [12_500, 18_300]);
    expect(result.grounded).toBe(false);
  });

  it("accepts display rounding", () => {
    // 12,499.62 shown as 12,500 is an honest rendering of a real value.
    expect(verifyGrounded("Collected was 12,500.", [12_499.62]).grounded).toBe(true);
  });

  it("accepts a ratio quoted as a percentage", () => {
    expect(verifyGrounded("Conversion was 24%.", [0.24]).grounded).toBe(true);
    expect(verifyGrounded("Conversion was 0.24.", [24]).grounded).toBe(true);
  });

  it("accepts thousands shorthand", () => {
    expect(verifyGrounded("About 1.2 million collected.", [1_200_000]).grounded).toBe(true);
  });

  it("rejects a plausible-looking but unsourced total", () => {
    // Close is not the same as sourced: 13,000 against 12,500 is a 4% gap, well
    // outside display rounding.
    expect(verifyGrounded("Collected was 13,000.", [12_500]).grounded).toBe(false);
  });

  it("passes an answer with no figures at all", () => {
    expect(
      verifyGrounded("That metric is not available until payments are mapped.", []).grounded,
    ).toBe(true);
  });

  it("rejects any figure when no tool returned a number", () => {
    // The strongest case: the model answered without calling anything.
    expect(verifyGrounded("Revenue was 40,000.", []).grounded).toBe(false);
  });

  it("refuses in the language the user asked in", () => {
    expect(groundingRefusal("ar")).toContain("مقدرتش");
    expect(groundingRefusal("en")).toContain("could not answer");
  });

  it("says plainly that the answer was withheld", () => {
    // A hedged paragraph would hide that the system caught itself, which is the
    // one thing the customer most needs to know.
    for (const lang of ["ar", "en"] as const) {
      expect(groundingRefusal(lang).length).toBeGreaterThan(40);
    }
  });
});
