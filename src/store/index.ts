export const STORE_SCHEMA_VERSION = 6 as const;
export { BridgeDatabase } from "./database.js";
export {
  AclRepository,
  AgentRepository,
  AuditRepository,
  MessageRepository,
  RecipientLeaseRepository,
} from "./repositories.js";
export type { AclRuleRecord, AuditEventRecord } from "./repositories.js";
export { GroupRepository } from "./groups.js";
export type {
  GroupMemberRecord,
  GroupMessageRecord,
  GroupRecord,
  GroupRole,
  GroupStatus,
} from "./groups.js";
export { assertMessageTransition, MESSAGE_TRANSITIONS } from "./models.js";
export type {
  AgentRecord,
  AgentOwnerBinding,
  AgentOwnerMode,
  AgentStatus,
  MessageKind,
  MessageRecord,
  MessageStatus,
} from "./models.js";
