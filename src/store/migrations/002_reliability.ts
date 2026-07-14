export const migration002 = {
  version: 2,
  name: "idempotency scheduling and dependency graph",
  sql: `
ALTER TABLE messages ADD COLUMN idempotency_key TEXT;
ALTER TABLE messages ADD COLUMN next_attempt_at TEXT;
ALTER TABLE messages ADD COLUMN expires_at TEXT;
CREATE UNIQUE INDEX messages_sender_idempotency
  ON messages(sender_agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_dispatch_order
  ON messages(recipient_agent_id, recipient_generation, status, next_attempt_at, created_at, message_id);
CREATE TABLE dependency_edges (
  message_id TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
  from_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  to_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX dependency_edges_active_from ON dependency_edges(from_agent_id, status);
CREATE INDEX dependency_edges_active_to ON dependency_edges(to_agent_id, status);
`,
} as const;
