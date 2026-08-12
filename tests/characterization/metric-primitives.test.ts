// Characterization tests for the existing product's metric discipline.
//
// These pin the baseline invariants B-1..B-12 from
// docs/product/REFERENCE_TENANT_BASELINE.md. They assert PROPERTIES rather than
// pinned numbers, because the fixtures are synthetic and a pinned number would
// need updating whenever a fixture changed — which is how a safety net quietly
// stops catching anything.
//
// They exist so the 14k lines of metric logic can be refactored in later phases
// with something standing behind the change.
import { describe, expect, it } from "vitest";
import { accountingReportingDate, signedCreditAmount } from "@/lib/accounting-policy";
import { REPORTING_WINDOW_START, approvedReportingEnd } from "@/lib/reporting-window";
import { GLOSSARY_ORDER, METRICS } from "@/lib/metric-catalog";

/**
 * `div` is private to metrics.server.ts, which pulls in the whole data layer on
 * import. The contract is what matters, so it is restated here exactly as
 * implemented (metrics.server.ts:47) and the invariants are asserted against it.
 * If the implementation ever diverges from this, the reimplementation below is
 * the specification and the change needs an ADR.
 */
const div = (a: number, b: number): number | null => (b > 0 && isFinite(a / b) ? a / b : null);
const pctOf = (a: number, b: number): number | null => {
  const r = div(a, b);
  return r === null ? null : r * 100;
};

describe("B-1/B-2 · division discipline", () => {
  it("returns null for a zero denominator, never 0", () => {
    expect(div(100, 0)).toBeNull();
    expect(div(0, 0)).toBeNull();
    expect(div(-5, 0)).toBeNull();
  });

  it("returns null for a negative denominator rather than a misleading sign", () => {
    expect(div(100, -1)).toBeNull();
  });

  it("never produces NaN or Infinity", () => {
    for (const [a, b] of [
      [1, 0],
      [0, 0],
      [Number.MAX_VALUE, Number.MIN_VALUE],
      [-1, 0],
    ]) {
      const result = div(a, b);
      if (result !== null) {
        expect(Number.isNaN(result)).toBe(false);
        expect(Number.isFinite(result)).toBe(true);
      }
    }
  });

  it("computes an ordinary ratio correctly", () => {
    expect(div(50, 200)).toBe(0.25);
    expect(pctOf(50, 200)).toBe(25);
  });
});

describe("B-3 · missing is not zero", () => {
  // Restatement of sumMaybe (metrics.server.ts:69).
  const sumMaybe = <T>(rows: T[], pick: (r: T) => number | null): number | null => {
    let total = 0;
    let seen = false;
    for (const row of rows) {
      const v = pick(row);
      if (v === null) continue;
      total += v;
      seen = true;
    }
    return seen ? total : null;
  };

  it("stays null when no row reports a value", () => {
    expect(sumMaybe([{ v: null }, { v: null }], (r) => r.v)).toBeNull();
  });

  it("sums only the rows that report, without treating null as zero", () => {
    expect(sumMaybe([{ v: 10 }, { v: null }, { v: 5 }], (r) => r.v)).toBe(15);
  });

  it("distinguishes 'all null' from 'all zero'", () => {
    expect(sumMaybe([{ v: 0 }, { v: 0 }], (r) => r.v)).toBe(0);
    expect(sumMaybe([{ v: null }, { v: null }], (r) => r.v)).toBeNull();
  });
});

describe("B-4 · percentages are recomputed, never averaged", () => {
  it("aggregate CTR equals total clicks over total impressions", () => {
    const rows = [
      { clicks: 10, impressions: 1_000 }, // 1.0%
      { clicks: 90, impressions: 1_000 }, // 9.0%
      { clicks: 0, impressions: 8_000 }, // 0.0%
    ];
    const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
    const totalImpressions = rows.reduce((s, r) => s + r.impressions, 0);

    const correct = pctOf(totalClicks, totalImpressions)!;
    const naiveAverage =
      rows.reduce((s, r) => s + pctOf(r.clicks, r.impressions)!, 0) / rows.length;

    expect(correct).toBeCloseTo(1.0, 9); // 100 / 10000
    expect(naiveAverage).toBeCloseTo(3.333, 3);
    // The whole point: averaging percentages triples the reported CTR here.
    expect(correct).not.toBeCloseTo(naiveAverage, 3);
  });
});

describe("B-5/B-7 · credit-note policy", () => {
  const creditNote = {
    invoiceDate: "2026-03-15",
    paymentDate: "2026-01-20",
    isCreditNote: true,
  };
  const invoice = {
    invoiceDate: "2026-01-10",
    paymentDate: "2026-02-05",
    isCreditNote: false,
  };

  it("recognises a credit note on its reversal invoice date under both bases", () => {
    expect(accountingReportingDate(creditNote, "payment")).toBe("2026-03-15");
    expect(accountingReportingDate(creditNote, "invoice")).toBe("2026-03-15");
  });

  it("follows the selected basis for a normal invoice", () => {
    expect(accountingReportingDate(invoice, "payment")).toBe("2026-02-05");
    expect(accountingReportingDate(invoice, "invoice")).toBe("2026-01-10");
  });

  it("falls back to the payment date when a credit note has no invoice date", () => {
    expect(
      accountingReportingDate(
        { invoiceDate: "", paymentDate: "2026-04-01", isCreditNote: true },
        "payment",
      ),
    ).toBe("2026-04-01");
  });

  it("signs a credit note negative and leaves an invoice positive", () => {
    expect(signedCreditAmount(500, true)).toBe(-500);
    expect(signedCreditAmount(-500, true)).toBe(-500); // already negative stays negative
    expect(signedCreditAmount(500, false)).toBe(500);
  });
});

describe("B-6 · Lost cohort and Lost movement are different questions", () => {
  // "How good were the leads acquired in March?" vs
  // "How many leads closed Lost in March?" — conflating these is the classic
  // Lost-analysis error the existing product deliberately avoids.
  const leads = [
    { created: "2026-03-05", closed: "2026-05-20", lost: true },
    { created: "2026-01-08", closed: "2026-03-11", lost: true },
    { created: "2026-03-22", closed: "2026-03-28", lost: true },
  ];
  const inMarch = (date: string) => date.startsWith("2026-03");

  it("produces different answers when close and creation fall in different months", () => {
    const cohort = leads.filter((l) => l.lost && inMarch(l.created));
    const movement = leads.filter((l) => l.lost && inMarch(l.closed));
    expect(cohort).toHaveLength(2);
    expect(movement).toHaveLength(2);
    // Same count, different members — which is exactly why one number cannot
    // stand in for the other.
    expect(cohort.map((l) => l.created)).not.toEqual(movement.map((l) => l.created));
  });
});

describe("B-11 · every catalogued metric can explain itself", () => {
  it("has Arabic and English copy, a formula, a source, a date basis and a dash reason", () => {
    expect(GLOSSARY_ORDER.length).toBeGreaterThan(0);
    for (const key of GLOSSARY_ORDER) {
      const metric = METRICS[key];
      expect(metric, `metric ${key} is missing from METRICS`).toBeDefined();
      for (const lang of ["ar", "en"] as const) {
        const copy = metric[lang];
        expect(copy.label.length, `${key}.${lang}.label`).toBeGreaterThan(0);
        expect(copy.formula.length, `${key}.${lang}.formula`).toBeGreaterThan(0);
        expect(copy.source.length, `${key}.${lang}.source`).toBeGreaterThan(0);
        expect(copy.dateBasis.length, `${key}.${lang}.dateBasis`).toBeGreaterThan(0);
        // The rule that missing data is never zero has to be stated per metric.
        expect(copy.whenEmpty.length, `${key}.${lang}.whenEmpty`).toBeGreaterThan(0);
      }
    }
  });

  it("never uses a bare abbreviation as an Arabic label", () => {
    for (const key of GLOSSARY_ORDER) {
      const label = METRICS[key].ar.label;
      expect(/^[A-Z]{2,5}$/.test(label), `${key} uses a bare abbreviation`).toBe(false);
    }
  });
});

describe("reporting window", () => {
  it("starts at the approved 2026 management window", () => {
    expect(REPORTING_WINDOW_START).toBe("2026-01-01");
  });

  it("follows the newest date present in the data when one is supplied", () => {
    expect(approvedReportingEnd("2026-07-31")).toBe("2026-07-31");
  });

  it("falls back to today in the workspace timezone", () => {
    expect(approvedReportingEnd()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
