export const migration003 = {
  version: 3,
  name: "access control and immutable audit trail",
  sql: `
CREATE TABLE agent_acl (
  sender_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  recipient_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sender_agent_id, recipient_agent_id),
  CHECK (sender_agent_id <> recipient_agent_id)
);
CREATE TABLE audit_events (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  message_id TEXT,
  conversation_id TEXT,
  sender_agent_id TEXT,
  recipient_agent_id TEXT,
  recipient_generation INTEGER,
  target_thread_id TEXT,
  target_turn_id TEXT,
  status TEXT,
  attempt_count INTEGER
);
CREATE INDEX audit_events_message ON audit_events(message_id, audit_id);
CREATE INDEX audit_events_conversation ON audit_events(conversation_id, audit_id);
CREATE TRIGGER audit_message_created AFTER INSERT ON messages BEGIN
  INSERT INTO audit_events(event_type, occurred_at, message_id, conversation_id, sender_agent_id,
    recipient_agent_id, recipient_generation, target_thread_id, target_turn_id, status, attempt_count)
  VALUES ('message.created', NEW.created_at, NEW.message_id, NEW.conversation_id, NEW.sender_agent_id,
    NEW.recipient_agent_id, NEW.recipient_generation, NEW.target_thread_id, NEW.target_turn_id, NEW.status,
    NEW.attempt_count);
END;
CREATE TRIGGER audit_message_status AFTER UPDATE OF status ON messages
WHEN OLD.status <> NEW.status BEGIN
  INSERT INTO audit_events(event_type, occurred_at, message_id, conversation_id, sender_agent_id,
    recipient_agent_id, recipient_generation, target_thread_id, target_turn_id, status, attempt_count)
  VALUES ('message.' || NEW.status, COALESCE(NEW.completed_at, NEW.delivered_at, CURRENT_TIMESTAMP),
    NEW.message_id, NEW.conversation_id, NEW.sender_agent_id, NEW.recipient_agent_id,
    NEW.recipient_generation, NEW.target_thread_id, NEW.target_turn_id, NEW.status, NEW.attempt_count);
END;
CREATE TRIGGER audit_attempt_started AFTER INSERT ON delivery_attempts BEGIN
  INSERT INTO audit_events(event_type, occurred_at, message_id, conversation_id, sender_agent_id,
    recipient_agent_id, recipient_generation, target_thread_id, target_turn_id, status, attempt_count)
  SELECT 'attempt.started', NEW.started_at, m.message_id, m.conversation_id, m.sender_agent_id,
    m.recipient_agent_id, m.recipient_generation, m.target_thread_id, NEW.target_turn_id, m.status,
    NEW.attempt_number FROM messages m WHERE m.message_id = NEW.message_id;
END;
CREATE TRIGGER audit_attempt_finished AFTER UPDATE OF finished_at ON delivery_attempts
WHEN OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL BEGIN
  INSERT INTO audit_events(event_type, occurred_at, message_id, conversation_id, sender_agent_id,
    recipient_agent_id, recipient_generation, target_thread_id, target_turn_id, status, attempt_count)
  SELECT 'attempt.finished', NEW.finished_at, m.message_id, m.conversation_id, m.sender_agent_id,
    m.recipient_agent_id, m.recipient_generation, m.target_thread_id, NEW.target_turn_id, m.status,
    NEW.attempt_number FROM messages m WHERE m.message_id = NEW.message_id;
END;
`,
} as const;
