// Metadata discovery — milestone acceptance E (deterministic discovery).
import { describe, expect, it } from "vitest";
import { discoverSchema } from "@/platform/discovery/discover";
import { SafeOdooConnector } from "@/platform/odoo/connector";
import { DISCOVERY_ALLOWLIST } from "@/platform/odoo/allowlist";
import { contentHash } from "@/platform/contracts";
import { createMockOdoo, DEFAULT_MODELS, MOCK_CREDENTIALS } from "../fixtures/mock-odoo";

function connect(mockOptions = {}) {
  const mock = createMockOdoo(mockOptions);
  const connector = new SafeOdooConnector(MOCK_CREDENTIALS, {
    // Discovery may follow relations, so the connector is scoped to the full
    // follow allowlist rather than only the initial models.
    allowedModels: new Set([
      ...DISCOVERY_ALLOWLIST,
      "res.partner",
      "res.country",
      "crm.lost.reason",
      "uom.uom",
      "account.journal",
      "account.account",
      "utm.campaign",
      "utm.source",
      "utm.medium",
    ]),
    fetchImpl: mock.fetch,
    attempts: 1,
    timeoutMs: 5_000,
  });
  return { mock, connector };
}

describe("discoverSchema", () => {
  it("discovers exactly the allowlist plus permitted relations", async () => {
    const { connector } = connect();
    const result = await discoverSchema(connector);

    const discovered = new Set(result.payload.models.map((m) => m.model));
    for (const model of DISCOVERY_ALLOWLIST) expect(discovered.has(model)).toBe(true);

    // Reached by relation, and on the follow allowlist.
    expect(discovered.has("res.partner")).toBe(true);
    expect(discovered.has("crm.lost.reason")).toBe(true);

    // Never scanned: not on the allowlist, however many relations point at it.
    expect(discovered.has("ir.attachment")).toBe(false);
    expect(discovered.has("mail.message")).toBe(false);
  });

  it("is deterministic — the same Odoo produces the same hash", async () => {
    const first = await discoverSchema(connect().connector);
    const second = await discoverSchema(connect().connector);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toHaveLength(64);
  });

  it("hashes independently of the order Odoo answers in", async () => {
    const { payload } = await discoverSchema(connect().connector);
    const shuffled = {
      models: [...payload.models].reverse(),
      fields: [...payload.fields].reverse(),
      relations: [...payload.relations].reverse(),
    };
    // sortSnapshotPayload runs inside discoverSchema, so the hash of the sorted
    // payload must equal the hash of a re-sorted shuffle.
    const { sortSnapshotPayload } = await import("@/platform/contracts");
    expect(contentHash(sortSnapshotPayload(shuffled))).toBe(contentHash(payload));
  });

  it("changes the hash when a custom field is added", async () => {
    const before = await discoverSchema(connect().connector);
    const models = structuredClone(DEFAULT_MODELS);
    models["crm.lead"].fields.x_new_custom_field = { string: "New Field", type: "char" };
    const after = await discoverSchema(connect({ models }).connector);
    expect(after.hash).not.toBe(before.hash);
  });

  it("captures custom x_ fields including Arabic labels", async () => {
    const { payload } = await discoverSchema(connect().connector);
    const custom = payload.fields.filter((f) => f.model === "crm.lead" && f.isCustom);
    expect(custom.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        "x_course_name",
        "x_studio_campaign_ref",
        "x_lead_quality",
        "x_computed_score",
      ]),
    );
    expect(custom.find((f) => f.name === "x_course_name")?.label).toBe("اسم الدورة");
  });

  it("stores prompt-injection text in help as inert data", async () => {
    const { payload } = await discoverSchema(connect().connector);
    const field = payload.fields.find((f) => f.name === "x_studio_campaign_ref");
    // It is preserved verbatim — discovery must not silently rewrite customer
    // metadata — but it lives in a data field and is never an instruction.
    expect(field?.help).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    expect(field?.label).toBe("Campaign Reference");
  });

  it("captures selection values with their labels", async () => {
    const { payload } = await discoverSchema(connect().connector);
    const quality = payload.fields.find((f) => f.name === "x_lead_quality");
    expect(quality?.type).toBe("selection");
    expect(quality?.selectionValues).toEqual([
      { value: "hot", label: "ساخن" },
      { value: "warm", label: "دافئ" },
      { value: "cold", label: "بارد" },
    ]);
  });

  it("marks a non-stored computed field", async () => {
    const { payload } = await discoverSchema(connect().connector);
    const computed = payload.fields.find((f) => f.name === "x_computed_score");
    expect(computed?.stored).toBe(false);
    expect(computed?.computed).toBe(true);
  });

  it("records relations with their cardinality", async () => {
    const { payload } = await discoverSchema(connect().connector);
    expect(payload.relations).toContainEqual({
      fromModel: "sale.order",
      fromField: "order_line",
      toModel: "sale.order.line",
      kind: "one2many",
    });
    expect(payload.relations).toContainEqual({
      fromModel: "crm.lead",
      fromField: "stage_id",
      toModel: "crm.stage",
      kind: "many2one",
    });
  });

  it("turns an ACL denial into a permission gap and keeps going", async () => {
    const { payload, permissionGaps } = await discoverSchema(connect().connector);

    const gap = permissionGaps.find((g) => g.model === "account.partial.reconcile");
    expect(gap?.reason).toBe("access_denied");
    expect(gap?.operation).toBe("fields_get");

    // Denied model is recorded as inaccessible, not omitted...
    const denied = payload.models.find((m) => m.model === "account.partial.reconcile");
    expect(denied?.accessible).toBe(false);
    // ...and the rest of the scan completed.
    expect(payload.models.find((m) => m.model === "crm.lead")?.accessible).toBe(true);
    expect(payload.models.length).toBeGreaterThan(10);
  });

  it("records a missing model without failing the scan", async () => {
    const models = structuredClone(DEFAULT_MODELS);
    models["account.payment"] = { ...models["account.payment"], missing: true };
    const { payload, permissionGaps } = await discoverSchema(connect({ models }).connector);
    expect(permissionGaps.find((g) => g.model === "account.payment")?.reason).toBe("model_missing");
    expect(payload.models.find((m) => m.model === "crm.lead")?.accessible).toBe(true);
  });

  it("reads no records — only metadata and counts", async () => {
    const { mock, connector } = connect();
    await discoverSchema(connector);
    const methods = new Set(mock.calls.map((c) => c.modelMethod).filter(Boolean));
    expect(methods).toEqual(new Set(["fields_get", "search_count"]));
    // Explicitly: nothing that returns record contents.
    expect(methods.has("search_read")).toBe(false);
    expect(methods.has("read")).toBe(false);
  });

  it("captures record counts without reading records", async () => {
    const { payload } = await discoverSchema(connect().connector);
    expect(payload.models.find((m) => m.model === "crm.lead")?.recordCount).toBe(18_432);
  });
});

describe("resumability", () => {
  it("resumes from a checkpoint without duplicating or losing models", async () => {
    // First pass: stop after a few models by aborting.
    const controller = new AbortController();
    let checkpoint: Record<string, unknown> = {};
    const { connector: first } = connect();

    await discoverSchema(first, {
      ctx: {
        signal: controller.signal,
        resumeFrom: {},
        checkpoint: async (state) => {
          checkpoint = state;
          const done = (state.completedModels as string[]).length;
          if (done >= 4) controller.abort();
        },
      },
    });

    const partial = (checkpoint.completedModels as string[]) ?? [];
    expect(partial.length).toBeGreaterThanOrEqual(4);
    expect(partial.length).toBeLessThan(DISCOVERY_ALLOWLIST.length);

    // Second pass resumes from that checkpoint.
    const { connector: second } = connect();
    const resumed = await discoverSchema(second, {
      ctx: {
        signal: new AbortController().signal,
        resumeFrom: checkpoint,
        checkpoint: async () => {},
      },
    });

    const names = resumed.payload.models.map((m) => m.model);
    expect(new Set(names).size).toBe(names.length); // no duplicates

    // And the result matches an uninterrupted run exactly.
    const clean = await discoverSchema(connect().connector);
    expect(resumed.hash).toBe(clean.hash);
  });

  it("does not re-request models already completed", async () => {
    const clean = await discoverSchema(connect().connector);
    const checkpoint = {
      completedModels: clean.payload.models.map((m) => m.model),
      models: clean.payload.models,
      fields: clean.payload.fields,
      relations: clean.payload.relations,
      gaps: clean.permissionGaps,
      odooVersion: clean.odooVersion,
    };

    const { mock, connector } = connect();
    await discoverSchema(connector, {
      ctx: {
        signal: new AbortController().signal,
        resumeFrom: checkpoint,
        checkpoint: async () => {},
      },
    });
    expect(mock.calls.filter((c) => c.modelMethod === "fields_get")).toHaveLength(0);
  });
});
