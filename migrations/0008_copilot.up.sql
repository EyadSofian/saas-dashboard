-- 0008 · Copilot conversations and their tool trail.
--
-- Every answer records the tool calls that produced it. Without that trail an
-- answer is an assertion; with it, a customer can see which metric, which
-- period and which generation each number came from.

CREATE TABLE copilot_conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  title        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX copilot_conversations_workspace_idx
  ON copilot_conversations (workspace_id, updated_at DESC);

CREATE TABLE copilot_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES copilot_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant')),
  content         text NOT NULL DEFAULT '',
  -- The tool calls and their results. This is the evidence behind the answer.
  tool_trail      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Which generation the numbers came from, so an answer stays interpretable
  -- after the next sync changes them.
  generation_id   uuid,
  -- Set when a number in the draft answer did not match any tool result. The
  -- answer is refused, and the attempt is kept so the failure is measurable.
  grounding_error text,
  model           text,
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX copilot_messages_conversation_idx
  ON copilot_messages (workspace_id, conversation_id, created_at);

CREATE TABLE copilot_feedback (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES copilot_messages(id) ON DELETE CASCADE,
  helpful    boolean NOT NULL,
  note       text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX copilot_feedback_message ON copilot_feedback (workspace_id, message_id);

SELECT apply_workspace_rls(t) FROM unnest(ARRAY[
  'copilot_conversations'::regclass, 'copilot_messages'::regclass, 'copilot_feedback'::regclass
]) AS t;
