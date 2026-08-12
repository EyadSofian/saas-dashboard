import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/v1/copilot")({
  server: {
    handlers: {
      // Answers a question using approved metrics only.
      //
      // The workspace comes from the session, never from the body: the model
      // names tools and arguments, but it cannot name a workspace, so no prompt
      // can redirect a query at someone else's data.
      POST: async ({ request }) => {
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

        const question =
          typeof payload.question === "string" ? payload.question.slice(0, 1000) : "";
        if (question.trim().length < 2) return errorResponse("Ask a question.", 400);
        const lang = payload.lang === "en" ? "en" : "ar";

        try {
          const { ask } = await import("@/platform/copilot/agent");
          const answer = await ask(guard.context, { question, lang });

          const { withWorkspace } = await import("@/platform/db/pool");
          const { activeGeneration } = await import("@/platform/sync/run");
          const generationId = await activeGeneration(guard.context);

          // The conversation and its tool trail are recorded so an answer stays
          // interpretable after the next sync changes the numbers.
          const messageId = await withWorkspace(guard.context, async (client) => {
            const conversation = await client.query<{ id: string }>(
              `INSERT INTO copilot_conversations (workspace_id, user_id, title)
               VALUES ($1,$2,$3) RETURNING id`,
              [guard.context.workspaceId, guard.context.userId, question.slice(0, 120)],
            );
            const conversationId = conversation.rows[0].id;

            await client.query(
              `INSERT INTO copilot_messages (workspace_id, conversation_id, role, content)
               VALUES ($1,$2,'user',$3)`,
              [guard.context.workspaceId, conversationId, question],
            );

            const assistant = await client.query<{ id: string }>(
              `INSERT INTO copilot_messages
                 (workspace_id, conversation_id, role, content, tool_trail, generation_id,
                  grounding_error, model, latency_ms)
               VALUES ($1,$2,'assistant',$3,$4::jsonb,$5,$6,$7,$8)
               RETURNING id`,
              [
                guard.context.workspaceId,
                conversationId,
                answer.answer,
                JSON.stringify(answer.toolTrail),
                generationId,
                answer.groundingError,
                answer.usedModel,
                answer.latencyMs,
              ],
            );
            return assistant.rows[0].id;
          });

          return jsonResponse({
            ok: true,
            messageId,
            answer: answer.answer,
            // The evidence, so the customer can see which metric and which
            // period every figure came from.
            toolTrail: answer.toolTrail.map((entry) => ({
              tool: entry.call.name,
              arguments: entry.call.arguments,
              ok: entry.result.ok,
              error: entry.result.error,
            })),
            grounded: answer.groundingError === null,
            generationId,
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  },
});
