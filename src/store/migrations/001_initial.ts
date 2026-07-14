export const migration001 = {
  version: 1,
  name: "initial durable messaging schema",
  sql: `
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  active_thread_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  workspace TEXT NOT NULL,
  accepts_messages INTEGER NOT NULL DEFAULT 1 CHECK (accepts_messages IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'superseded', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE agent_thread_generations (
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  PRIMARY KEY (agent_id, generation)
);
CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_message_id TEXT REFERENCES messages(message_id),
  sender_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  recipient_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  recipient_generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'reply', 'notice')),
  body TEXT NOT NULL,
  expects_reply INTEGER NOT NULL CHECK (expects_reply IN (0, 1)),
  hop_count INTEGER NOT NULL DEFAULT 0 CHECK (hop_count >= 0),
  call_chain_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'dispatching', 'running', 'completed', 'failed', 'dead_letter')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  completed_at TEXT,
  target_thread_id TEXT,
  target_turn_id TEXT,
  reply_body TEXT,
  error_code TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  FOREIGN KEY (recipient_agent_id, recipient_generation)
    REFERENCES agent_thread_generations(agent_id, generation)
);
CREATE INDEX messages_recipient_queue ON messages(recipient_agent_id, status, created_at);
CREATE TABLE delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  app_server_request_id TEXT,
  target_turn_id TEXT,
  result TEXT,
  error TEXT,
  UNIQUE (message_id, attempt_number)
);
CREATE TABLE recipient_leases (
  recipient_thread_id TEXT PRIMARY KEY,
  owner_instance_id TEXT NOT NULL,
  lease_token TEXT NOT NULL UNIQUE,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`,
} as const;
