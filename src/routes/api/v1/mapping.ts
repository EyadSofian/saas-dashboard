import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/mapping")({
  server: {
    handlers: {
      // The manifest under review, its mappings and its open policy questions.
      GET: async ({ request }) => {
        const { requireWorkspace, jsonResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { currentManifest, listMappings, listPolicies, publishBlockers } =
            await import("@/platform/semantic/repository");
          const manifest = await currentManifest(guard.context);
          if (!manifest)
            return jsonResponse({ ok: true, manifest: null, mappings: [], policies: [] });

          const [mappings, policies, blockers] = await Promise.all([
            listMappings(guard.context, manifest.id),
            listPolicies(guard.context, manifest.id),
            publishBlockers(guard.context, manifest.id),
          ]);
          const { CANONICAL_CONCEPTS } = await import("@/platform/semantic/concepts");

          return jsonResponse({
            ok: true,
            manifest,
            mappings,
            policies,
            blockers,
            concepts: CANONICAL_CONCEPTS,
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },

      // Generates a fresh proposal from the latest snapshot.
      POST: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        try {
          const { latestSnapshot, snapshotModels, snapshotFields } =
            await import("@/platform/workspace/repository");
          const snapshot = await latestSnapshot(guard.context);
          if (!snapshot) return errorResponse("No schema snapshot yet.", 409);

          // Rebuild the snapshot payload the proposer needs.
          const models = await snapshotModels(guard.context, snapshot.id);
          // snapshotFields selects per model and omits the model column, so it
          // is reattached here rather than widening the repository query.
          const fields: Array<Record<string, unknown>> = (
            await Promise.all(
              models.map(async (m) => {
                const rows = await snapshotFields(guard.context, snapshot.id, String(m.model));
                return rows.map((f): Record<string, unknown> => ({ ...f, model: String(m.model) }));
              }),
            )
          ).flat();

          const { withWorkspace } = await import("@/platform/db/pool");
          const relations = await withWorkspace(guard.context, async (client) => {
            const { rows } = await client.query(
              `SELECT from_model, from_field, to_model, kind FROM schema_relations
                WHERE workspace_id = $1 AND snapshot_id = $2`,
              [guard.context.workspaceId, snapshot.id],
            );
            return rows;
          });

          // Parse what came out of the database through the snapshot contract:
          // it validates the shape and narrows the string columns to their
          // unions, so a corrupted row fails here rather than deep in the
          // proposer.
          const { snapshotPayloadSchema } = await import("@/platform/contracts");
          const parsedPayload = snapshotPayloadSchema.safeParse({
            models: models.map((m) => ({
              model: String(m.model),
              label: String(m.label ?? ""),
              origin: m.origin === "relation" ? "relation" : "allowlist",
              accessible: Boolean(m.accessible),
              fieldCount: Number(m.field_count ?? 0),
              recordCount: m.record_count === null ? null : Number(m.record_count),
            })),
            fields: fields.map((f) => ({
              model: String(f.model ?? ""),
              name: String(f.name),
              label: String(f.label ?? ""),
              help: f.help ? String(f.help) : null,
              type: String(f.type),
              relation: f.relation ? String(f.relation) : null,
              relationField: f.relation_field ? String(f.relation_field) : null,
              required: Boolean(f.required),
              readonly: Boolean(f.readonly),
              stored: Boolean(f.stored),
              computed: Boolean(f.computed),
              isCustom: Boolean(f.is_custom),
              selectionValues: f.selection_values ?? null,
            })),
            relations: relations.map((r) => ({
              fromModel: String(r.from_model),
              fromField: String(r.from_field),
              toModel: String(r.to_model),
              kind: String(r.kind),
            })),
          });
          if (!parsedPayload.success) {
            return errorResponse("The stored schema snapshot is not readable.", 500);
          }
          const payload = parsedPayload.data;

          const { DeterministicProposer, entityModelMap } =
            await import("@/platform/semantic/proposer");
          const { AiProposer } = await import("@/platform/semantic/ai-proposer");
          const { validateProposal } = await import("@/platform/semantic/validate");
          const { FLAGS } = await import("@/platform/flags");

          const deterministic = new DeterministicProposer();
          // AI refines only what the rules could not resolve; without a key the
          // product still produces a complete, reviewable proposal.
          const proposer = FLAGS.aiMapping() ? new AiProposer(deterministic) : deterministic;
          const proposal = await proposer.propose({ snapshotId: snapshot.id, payload });

          // Nothing reaches storage without existing in the snapshot.
          const { accepted, rejected } = validateProposal(
            proposal,
            payload,
            entityModelMap(proposal.entities),
          );

          const { createManifestFromProposal } = await import("@/platform/semantic/repository");
          const manifest = await createManifestFromProposal(guard.context, {
            snapshotId: snapshot.id,
            proposal: { ...proposal, fields: accepted },
            aiRun: proposer instanceof AiProposer ? proposer.lastRun : null,
          });

          const { setOnboardingState } = await import("@/platform/workspace/repository");
          await setOnboardingState(guard.context, "mapping_review");

          const { writeAudit } = await import("@/platform/audit/log");
          await writeAudit(guard.context, {
            action: "mapping.proposed",
            targetType: "semantic_manifest",
            targetId: manifest.id,
            metadata: {
              proposer: proposer.id,
              accepted: accepted.length,
              rejected: rejected.length,
            },
          });

          return jsonResponse({ ok: true, manifest, rejected }, 201);
        } catch (error) {
          return handleRouteError(error);
        }
      },

      // Records a reviewer's decision on one mapping or policy.
      PATCH: async ({ request }) => {
        const { requireWorkspace, jsonResponse, errorResponse, handleRouteError } =
          await import("@/platform/api/guard");
        const guard = await requireWorkspace(request);
        if (!guard.ok) return guard.response;

        let payload: Record<string, unknown>;
        try {
          payload = await request.json();
        } catch {
          return errorResponse("Invalid JSON body.", 400);
        }

        try {
          const { currentManifest, decideMapping, decidePolicy } =
            await import("@/platform/semantic/repository");
          const manifest = await currentManifest(guard.context);
          if (!manifest) return errorResponse("No manifest under review.", 409);
          if (manifest.status === "published") {
            // A published manifest is immutable: re-propose to change it.
            return errorResponse("This manifest is already published.", 409);
          }

          const { mappingDecisionSchema, policyDecisionSchema } =
            await import("@/platform/semantic/contracts");
          const { writeAudit } = await import("@/platform/audit/log");

          if (payload.policyKey) {
            const parsed = policyDecisionSchema.safeParse(payload);
            if (!parsed.success) return errorResponse("Invalid policy decision.", 400);
            await decidePolicy(
              guard.context,
              manifest.id,
              parsed.data.policyKey,
              parsed.data.value,
            );
            await writeAudit(guard.context, {
              action: "policy.approved",
              targetType: "reporting_policy",
              targetId: parsed.data.policyKey,
              metadata: { value: parsed.data.value, manifestVersion: manifest.version },
            });
          } else {
            const parsed = mappingDecisionSchema.safeParse(payload);
            if (!parsed.success) return errorResponse("Invalid mapping decision.", 400);
            await decideMapping(guard.context, manifest.id, parsed.data);
            await writeAudit(guard.context, {
              action: `mapping.${parsed.data.status}`,
              targetType: "semantic_field_mapping",
              targetId: parsed.data.canonicalField,
              metadata: { manifestVersion: manifest.version },
            });
          }

          const { publishBlockers } = await import("@/platform/semantic/repository");
          return jsonResponse({
            ok: true,
            blockers: await publishBlockers(guard.context, manifest.id),
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
