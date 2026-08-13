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

  it("does not mistake an unset write_date for a cursor", async () => {
    // Odoo sends `false` for an unset datetime. `?? ` does not catch false, so
    // the cursor used to become the string "false" and the next domain asked
    // Odoo to compare a timestamp against nonsense.
    const page = rows(500, 1, "2026-01-01 00:00:00");
    page[page.length - 1].write_date = false;
    const { connector } = connectorReturning([page, rows(2, 501, "2026-01-02 00:00:00")]);

    // Falls back to the run's upper bound, which still advances the cursor, so
    // the read completes rather than throwing or looping.
    expect(await extractModel(connector, plan, UPPER, async () => undefined)).toBe(502);
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
