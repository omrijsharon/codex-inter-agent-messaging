export const migration005 = {
  version: 5,
  name: "groups membership snapshots and fanout deliveries",
  sql: `
ALTER TABLE messages ADD COLUMN group_id TEXT;
ALTER TABLE messages ADD COLUMN group_message_id TEXT;
CREATE TABLE groups (
  group_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  joined_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (group_id, agent_id)
);
CREATE TABLE group_messages (
  group_message_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(group_id),
  sender_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  conversation_id TEXT NOT NULL,
  body TEXT NOT NULL,
  membership_snapshot_json TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX group_messages_sender_idempotency
  ON group_messages(sender_agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE group_deliveries (
  delivery_id TEXT PRIMARY KEY,
  group_message_id TEXT NOT NULL REFERENCES group_messages(group_message_id) ON DELETE CASCADE,
  recipient_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id) ON DELETE CASCADE,
  delivery_sequence INTEGER NOT NULL CHECK (delivery_sequence >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (group_message_id, recipient_agent_id, delivery_sequence)
);
CREATE INDEX group_deliveries_message ON group_deliveries(group_message_id, recipient_agent_id, delivery_sequence);
`,
} as const;
