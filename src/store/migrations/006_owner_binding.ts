export const migration006 = {
  version: 6,
  name: "authoritative_owner_binding",
  sql: `
ALTER TABLE agents ADD COLUMN owner_mode TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE agents ADD COLUMN owner_installation_id TEXT;
ALTER TABLE agents ADD COLUMN owner_database_id TEXT;
ALTER TABLE agents ADD COLUMN owner_protocol_version TEXT;
ALTER TABLE agent_thread_generations ADD COLUMN owner_mode TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE agent_thread_generations ADD COLUMN owner_installation_id TEXT;
ALTER TABLE agent_thread_generations ADD COLUMN owner_database_id TEXT;
ALTER TABLE agent_thread_generations ADD COLUMN owner_protocol_version TEXT;
CREATE INDEX agents_owner_binding_idx
  ON agents(owner_mode, owner_installation_id, owner_database_id, owner_protocol_version);
`,
} as const;
