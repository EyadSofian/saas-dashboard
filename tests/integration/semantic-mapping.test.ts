// Semantic mapping: deterministic proposal, snapshot validation, AI overlay.
import { describe, expect, it } from "vitest";
import { discoverSchema } from "@/platform/discovery/discover";
import { SafeOdooConnector } from "@/platform/odoo/connector";
import { DISCOVERY_ALLOWLIST } from "@/platform/odoo/allowlist";
import {
  DeterministicProposer,
  entityModelMap,
  proposeEntities,
} from "@/platform/semantic/proposer";
import { AiProposer } from "@/platform/semantic/ai-proposer";
import { validateProposal } from "@/platform/semantic/validate";
import { alwaysRequiresApproval, CANONICAL_CONCEPTS } from "@/platform/semantic/concepts";
import type { MappingProposal } from "@/platform/semantic/contracts";
import { createMockOdoo, MOCK_CREDENTIALS } from "../fixtures/mock-odoo";

const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";

async function snapshot() {
  const mock = createMockOdoo();
  const connector = new SafeOdooConnector(MOCK_CREDENTIALS, {
    allowedModels: new Set([
      ...DISCOVERY_ALLOWLIST,
      "res.partner",
      "res.country",
      "crm.lost.reason",
    ]),
    fetchImpl: mock.fetch,
    attempts: 1,
  });
  const result = await discoverSchema(connector);
  return result.payload;
}

async function baselineProposal(): Promise<{
  proposal: MappingProposal;
  payload: Awaited<ReturnType<typeof snapshot>>;
}> {
  const payload = await snapshot();
  const proposal = await new DeterministicProposer().propose({ snapshotId: SNAPSHOT_ID, payload });
  return { proposal, payload };
}

describe("entity proposal", () => {
  it("maps canonical entities to their standard Odoo models", async () => {
    const entities = proposeEntities(await snapshot());
    const map = entityModelMap(entities);
    expect(map.get("lead")).toBe("crm.lead");
    expect(map.get("order")).toBe("sale.order");
    expect(map.get("invoice")).toBe("account.move");
    expect(map.get("payment")).toBe("account.payment");
  });

  it("leaves an entity unmapped rather than guessing when its model is absent", async () => {
    const payload = await snapshot();
    const stripped = {
      ...payload,
      models: payload.models.filter((m) => m.model !== "account.payment"),
    };
    const entities = proposeEntities(stripped);
    expect(entities.find((e) => e.canonicalEntity === "payment")?.odooModel).toBeNull();
  });
});

describe("deterministic proposer", () => {
  it("resolves the unambiguous standard fields with high confidence", async () => {
    const { proposal } = await baselineProposal();
    const byKey = new Map(proposal.fields.map((f) => [f.canonicalField, f]));

    for (const [concept, model, field] of [
      ["lead.createdAt", "crm.lead", "create_date"],
      ["lead.closedAt", "crm.lead", "date_closed"],
      ["order.orderedAt", "sale.order", "date_order"],
      ["order.amountTotal", "sale.order", "amount_total"],
      ["invoice.invoiceDate", "account.move", "invoice_date"],
      ["payment.date", "account.payment", "date"],
      ["payment.amount", "account.payment", "amount"],
    ] as const) {
      const mapping = byKey.get(concept);
      expect(mapping?.odooModel, concept).toBe(model);
      expect(mapping?.odooField, concept).toBe(field);
      expect(mapping?.confidence ?? 0, concept).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("never maps a money concept onto a non-numeric field", async () => {
    const { proposal, payload } = await baselineProposal();
    const types = new Map(payload.fields.map((f) => [`${f.model}.${f.name}`, f.type]));

    for (const mapping of proposal.fields) {
      if (!mapping.odooField) continue;
      const concept = CANONICAL_CONCEPTS.find((c) => c.key === mapping.canonicalField);
      if (concept?.type !== "money") continue;
      expect(["monetary", "float"]).toContain(
        types.get(`${mapping.odooModel}.${mapping.odooField}`),
      );
    }
  });

  it("attaches evidence to every confident mapping", async () => {
    const { proposal } = await baselineProposal();
    for (const mapping of proposal.fields) {
      if (mapping.confidence >= 0.75) {
        expect(mapping.evidence.length, mapping.canonicalField).toBeGreaterThan(0);
      }
    }
  });

  it("reports concepts it cannot find instead of guessing", async () => {
    const { proposal } = await baselineProposal();
    // Every unmapped concept is stated explicitly and carries a null path.
    for (const key of proposal.unmapped) {
      const mapping = proposal.fields.find((f) => f.canonicalField === key);
      expect(mapping?.odooField).toBeNull();
      expect(mapping?.confidence).toBe(0);
    }
  });

  it("penalises a non-stored computed field", async () => {
    const { proposal } = await baselineProposal();
    // x_computed_score is non-stored; nothing should have selected it.
    const selected = proposal.fields.filter((f) => f.odooField === "x_computed_score");
    for (const mapping of selected) expect(mapping.confidence).toBeLessThan(0.75);
  });
});

describe("financial concepts always require approval", () => {
  it("marks money, lifecycle and date concepts as high risk", () => {
    for (const key of [
      "invoice.amountTotal",
      "invoice.isCreditNote",
      "payment.date",
      "payment.amount",
      "lead.createdAt",
      "lead.closedAt",
      "lead.isWon",
      "order.amountTotal",
    ]) {
      expect(alwaysRequiresApproval(key), key).toBe(true);
    }
  });

  it("does not mark cosmetic concepts as high risk", () => {
    for (const key of ["invoice.number", "order.reference", "lead.lostReason"]) {
      expect(alwaysRequiresApproval(key), key).toBe(false);
    }
  });
});

describe("snapshot validation", () => {
  it("accepts a well-formed proposal", async () => {
    const { proposal, payload } = await baselineProposal();
    const { accepted, rejected } = validateProposal(
      proposal,
      payload,
      entityModelMap(proposal.entities),
    );
    expect(rejected).toEqual([]);
    expect(accepted.length).toBe(proposal.fields.length);
  });

  it("rejects an invented model", async () => {
    const { proposal, payload } = await baselineProposal();
    const tampered: MappingProposal = {
      ...proposal,
      fields: [
        {
          canonicalField: "invoice.amountTotal",
          odooModel: "secret.ledger",
          odooField: "amount",
          relationPath: [],
          confidence: 0.99,
          evidence: [],
          alternatives: [],
          riskLevel: "high",
          explanation: { ar: "", en: "" },
        },
      ],
    };
    const { accepted, rejected } = validateProposal(
      tampered,
      payload,
      entityModelMap(proposal.entities),
    );
    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe("unknown_model");
  });

  it("rejects an invented field on a real model", async () => {
    const { proposal, payload } = await baselineProposal();
    const tampered: MappingProposal = {
      ...proposal,
      fields: [
        {
          canonicalField: "invoice.amountTotal",
          odooModel: "account.move",
          odooField: "x_secret_backdoor",
          relationPath: [],
          confidence: 0.99,
          evidence: [],
          alternatives: [],
          riskLevel: "high",
          explanation: { ar: "", en: "" },
        },
      ],
    };
    const { rejected } = validateProposal(tampered, payload, entityModelMap(proposal.entities));
    expect(rejected[0].reason).toBe("unknown_field");
  });

  it("rejects a type-incompatible mapping", async () => {
    const { proposal, payload } = await baselineProposal();
    const tampered: MappingProposal = {
      ...proposal,
      fields: [
        {
          // `name` is a char field; it cannot carry a money concept.
          canonicalField: "invoice.amountTotal",
          odooModel: "account.move",
          odooField: "name",
          relationPath: [],
          confidence: 0.99,
          evidence: [],
          alternatives: [],
          riskLevel: "high",
          explanation: { ar: "", en: "" },
        },
      ],
    };
    const { rejected } = validateProposal(tampered, payload, entityModelMap(proposal.entities));
    expect(rejected[0].reason).toBe("type_mismatch");
  });

  it("rejects an unknown canonical concept", async () => {
    const { proposal, payload } = await baselineProposal();
    const tampered: MappingProposal = {
      ...proposal,
      fields: [
        {
          canonicalField: "invoice.giveMeEverything",
          odooModel: "account.move",
          odooField: "amount_total",
          relationPath: [],
          confidence: 1,
          evidence: [],
          alternatives: [],
          riskLevel: "low",
          explanation: { ar: "", en: "" },
        },
      ],
    };
    const { rejected } = validateProposal(tampered, payload, entityModelMap(proposal.entities));
    expect(rejected[0].reason).toBe("unknown_concept");
  });

  it("rejects a relation path that does not exist", async () => {
    const { proposal, payload } = await baselineProposal();
    const tampered: MappingProposal = {
      ...proposal,
      fields: [
        {
          canonicalField: "lead.stage",
          odooModel: "crm.stage",
          odooField: "name",
          relationPath: ["not_a_relation"],
          confidence: 0.9,
          evidence: [],
          alternatives: [],
          riskLevel: "high",
          explanation: { ar: "", en: "" },
        },
      ],
    };
    const { rejected } = validateProposal(tampered, payload, entityModelMap(proposal.entities));
    expect(rejected[0].reason).toBe("unknown_relation");
  });
});

describe("AI proposer", () => {
  const injected = {
    canonicalField: "lead.expectedRevenue",
    odooModel: "crm.lead",
    odooField: "expected_revenue",
    confidence: 0.88,
    reasoning: "Monetary field named expected revenue.",
    explanationAr: "حقل الإيراد المتوقع.",
    explanationEn: "The expected revenue field.",
  };

  it("only sends the concepts the rules could not resolve", async () => {
    const payload = await snapshot();
    let prompt = "";
    const proposer = new AiProposer(new DeterministicProposer(), {
      complete: async ({ user }) => {
        prompt = user;
        return JSON.stringify({ fields: [injected] });
      },
    });
    await proposer.propose({ snapshotId: SNAPSHOT_ID, payload });

    // Confidently-resolved concepts are absent from the prompt entirely.
    expect(prompt).not.toContain("lead.createdAt");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("fences customer metadata as untrusted data", async () => {
    const payload = await snapshot();
    let prompt = "";
    const proposer = new AiProposer(new DeterministicProposer(), {
      complete: async ({ user }) => {
        prompt = user;
        return JSON.stringify({ fields: [] });
      },
    });
    await proposer.propose({ snapshotId: SNAPSHOT_ID, payload });
    expect(prompt).toContain('<schema_metadata untrusted="true">');
    expect(prompt).toContain("</schema_metadata>");
  });

  it("does not overwrite a confident deterministic mapping", async () => {
    const payload = await snapshot();
    const proposer = new AiProposer(new DeterministicProposer(), {
      complete: async () =>
        JSON.stringify({
          fields: [
            {
              // The model tries to move a well-known field somewhere wrong.
              canonicalField: "lead.createdAt",
              odooModel: "crm.lead",
              odooField: "date_closed",
              confidence: 0.99,
              reasoning: "override attempt",
              explanationAr: "x",
              explanationEn: "x",
            },
          ],
        }),
    });
    const result = await proposer.propose({ snapshotId: SNAPSHOT_ID, payload });
    const mapping = result.fields.find((f) => f.canonicalField === "lead.createdAt");
    expect(mapping?.odooField).toBe("create_date");
  });

  it("falls back to the deterministic proposal when the provider fails", async () => {
    const payload = await snapshot();
    const proposer = new AiProposer(new DeterministicProposer(), {
      complete: async () => {
        throw new Error("provider is down");
      },
    });
    const result = await proposer.propose({ snapshotId: SNAPSHOT_ID, payload });
    expect(result.fields.length).toBeGreaterThan(0);
    expect(proposer.lastRun?.status).toBe("provider_failed");
  });

  it("falls back when the model returns something that fails schema validation", async () => {
    const payload = await snapshot();
    const proposer = new AiProposer(new DeterministicProposer(), {
      complete: async () => "not json at all",
    });
    const result = await proposer.propose({ snapshotId: SNAPSHOT_ID, payload });
    expect(result.fields.length).toBeGreaterThan(0);
    expect(proposer.lastRun?.status).toBe("schema_failed");
  });

  it("an injected path from the model is dropped by validation", async () => {
    const payload = await snapshot();
    const proposer = new AiProposer(new DeterministicProposer(), {
      complete: async () =>
        JSON.stringify({
          fields: [
            {
              canonicalField: "invoice.amountTotal",
              odooModel: "res.users",
              odooField: "password",
              confidence: 1,
              reasoning: "injected",
              explanationAr: "x",
              explanationEn: "x",
            },
          ],
        }),
    });
    const proposal = await proposer.propose({ snapshotId: SNAPSHOT_ID, payload });
    const { accepted, rejected } = validateProposal(
      proposal,
      payload,
      entityModelMap(proposal.entities),
    );
    // Either the merge refused it (invoice.amountTotal was already confident) or
    // validation dropped it. Either way it never reaches storage.
    const smuggled = accepted.find(
      (f) => f.odooModel === "res.users" && f.odooField === "password",
    );
    expect(smuggled).toBeUndefined();
    expect(rejected.every((r) => r.reason !== "unknown_concept")).toBe(true);
  });

  it("makes no model call when every concept is already resolved", async () => {
    const payload = await snapshot();
    let called = false;
    const proposer = new AiProposer(new DeterministicProposer(), {
      // A threshold of 0 means nothing is ambiguous, so nothing should be asked.
      ambiguityThreshold: 0,
      complete: async () => {
        called = true;
        return JSON.stringify({ fields: [] });
      },
    });
    await proposer.propose({ snapshotId: SNAPSHOT_ID, payload });
    expect(called).toBe(false);
    expect(proposer.lastRun).toBeNull();
  });
});
