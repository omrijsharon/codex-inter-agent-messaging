export const migration004 = {
  version: 4,
  name: "asynchronous inbox state",
  sql: `
ALTER TABLE messages ADD COLUMN inbox_read_at TEXT;
ALTER TABLE messages ADD COLUMN acknowledged_at TEXT;
CREATE INDEX messages_async_inbox
  ON messages(recipient_agent_id, expects_reply, status, created_at, message_id);
`,
} as const;
