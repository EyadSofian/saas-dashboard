// Keyset pagination over an Odoo model.
//
// The property that matters most here is not throughput, it is termination. A
// non-advancing cursor re-asks the same question and gets the same full page
// back; because it keeps reading pages, it keeps its lease alive and presents
// itself as a healthy running sync. There is no signal anywhere that separates
// that from slow honest work, so it has to fail loudly instead of spinning.
import { describe, expect, it } from "vitest";
import { extractModel } from "@/platform/sync/run";
import type { ExtractionPlan } from "@/platform/sync/plan";

const plan: ExtractionPlan = {
  entity: "invoice",
  odooModel: "account.move",
  fields: ["id", "write_date", "amount_total"],
  columns: { "invoice.amountTotal": "amount_total" },
  target: "fact_invoice",
  domain: [["state", "=", "posted"]],
};

/** crm.lead carries no policy domain — the model the real sync stalled on. */
const leadPlan: ExtractionPlan = {
  entity: "lead",
  odooModel: "crm.lead",
  fields: ["id", "write_date"],
  columns: {},
  target: "fact_lead",
  domain: [],
};

const UPPER = "2026-08-13 09:50:20";

/** A connector whose pages are supplied by a function of the call count. */
function connectorReturning(pages: Array<Array<Record<string, unknown>>>) {
  let call = 0;
  return {
    calls: () => call,
    connector: {
      call: async <T>(): Promise<T> => {
        const page = pages[Math.min(call, pages.length - 1)];
        call += 1;
        return page as T;
      },
    },
  };
}

function rows(count: number, startId: number, writeDate: string): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    write_date: writeDate,
    amount_total: 10,
  }));
}

/**
 * An Odoo that behaves like the real one in the way that matters here: it
 * stores microseconds on `write_date` and serialises them away, to the second.
 *
 * Every row below shares one second, which is ordinary for records created by
 * an import or a batch job — and is the exact shape that made a truncated
 * write_date cursor re-match the rows it had just read.
 */
function truncatingOdoo(total: number, pageSize = 500) {
  const stored = Array.from({ length: total }, (_, i) => ({
    id: i + 1,
    // Distinct microseconds inside a single second, as Odoo would store.
    trueWriteDate: `2026-01-15 10:23:45.${String(i).padStart(6, "0")}`,
    amount_total: 10,
  }));

  let calls = 0;
  const connector = {
    call: async <T>(_model: string, _method: string, args?: unknown[]): Promise<T> => {
      calls += 1;
      if (calls > 50) throw new Error("runaway: the read never terminated");

      const domain = (args?.[0] ?? []) as unknown[];
      const leaves = domain.filter(Array.isArray) as Array<[string, string, unknown]>;

      const matched = stored.filter((row) =>
        leaves.every(([field, op, value]) => {
          // write_date compares against the stored microsecond value, exactly
          // as PostgreSQL would — not against the truncated string sent out.
          const actual: string | number =
            field === "write_date" ? row.trueWriteDate : row[field as "id"];
          const bound = value as string | number;
          if (op === ">") return actual > bound;
          if (op === "<=") return actual <= bound;
          if (op === "=") return actual === bound;
          return true;
        }),
      );

      return matched.slice(0, pageSize).map((row) => ({
        id: row.id,
        // Serialised to the second, microseconds gone — as Odoo sends it.
        write_date: row.trueWriteDate.slice(0, 19),
        amount_total: row.amount_total,
      })) as T;
    },
  };

  return { connector, calls: () => calls };
}

describe("extractModel", () => {
  it("stops on a short page", async () => {
    const { connector, calls } = connectorReturning([rows(3, 1, "2026-01-01 00:00:00")]);
    const seen: number[] = [];

    const total = await extractModel(connector, plan, UPPER, async (page) => {
      seen.push(page.length);
    });

    expect(total).toBe(3);
    expect(seen).toEqual([3]);
    expect(calls()).toBe(1);
  });

  it("stops on an empty page", async () => {
    const { connector } = connectorReturning([[]]);
    expect(await extractModel(connector, plan, UPPER, async () => undefined)).toBe(0);
  });

  it("pages until the rows run out", async () => {
    const { connector } = connectorReturning([
      rows(500, 1, "2026-01-01 00:00:00"),
      rows(500, 501, "2026-01-02 00:00:00"),
      rows(7, 1001, "2026-01-03 00:00:00"),
    ]);

    expect(await extractModel(connector, plan, UPPER, async () => undefined)).toBe(1007);
  });

  it("refuses to loop when the cursor stops advancing", async () => {
    // Every page is full and identical — the shape a mis-ordered or
    // mis-filtered read produces, and an infinite loop under the old code.
    const stuck = rows(500, 1, "2026-01-01 00:00:00");
    const { connector, calls } = connectorReturning([stuck, stuck, stuck, stuck]);

    await expect(extractModel(connector, plan, UPPER, async () => undefined)).rejects.toThrow(
      /stopped making progress/,
    );

    // It gave up rather than reading forever.
    expect(calls()).toBeLessThan(4);
  });

  // The production failure, reproduced. Against a write_date cursor these rows
  // loop forever: the serialised value comes back truncated to the second, and
  // `write_date > '…:45'` still matches a row stored at `…:45.000123`.
  it("reads every row when a whole page shares one second of write_date", async () => {
    const { connector, calls } = truncatingOdoo(1200);
    let seen = 0;

    const total = await extractModel(connector, leadPlan, UPPER, async (page) => {
      seen += page.length;
    });

    expect(total).toBe(1200);
    expect(seen).toBe(1200);
    // 500 + 500 + 200: three pages, no repeats.
    expect(calls()).toBe(3);
  });

  it("returns each row exactly once across pages", async () => {
    const { connector } = truncatingOdoo(1200);
    const ids: number[] = [];

    await extractModel(connector, leadPlan, UPPER, async (page) => {
      for (const row of page) ids.push(Number(row.id));
    });

    expect(ids.length).toBe(1200);
    expect(new Set(ids).size).toBe(1200);
    expect(ids[0]).toBe(1);
    expect(ids[ids.length - 1]).toBe(1200);
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    const { connector } = connectorReturning([rows(500, 1, "2026-01-01 00:00:00")]);
    controller.abort();

    expect(
      await extractModel(connector, plan, UPPER, async () => undefined, controller.signal),
    ).toBe(0);
  });
});
