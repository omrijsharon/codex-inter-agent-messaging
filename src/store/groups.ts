import { randomUUID } from "node:crypto";
import type { BridgeDatabase } from "./database.js";
import type { MessageRecord } from "./models.js";
import { MessageRepository } from "./repositories.js";

export type GroupStatus = "active" | "paused" | "deleted";
export type GroupRole = "owner" | "member";

export interface GroupRecord {
  readonly groupId: string;
  readonly displayName: string;
  readonly ownerAgentId: string;
  readonly status: GroupStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GroupMemberRecord {
  readonly groupId: string;
  readonly agentId: string;
  readonly role: GroupRole;
  readonly active: boolean;
  readonly joinedAt: string;
  readonly removedAt: string | null;
}

export interface GroupMessageRecord {
  readonly groupMessageId: string;
  readonly groupId: string;
  readonly senderAgentId: string;
  readonly conversationId: string;
  readonly body: string;
  readonly membershipSnapshot: readonly string[];
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
}

type GroupRow = {
  group_id: string;
  display_name: string;
  owner_agent_id: string;
  status: GroupStatus;
  created_at: string;
  updated_at: string;
};
type MemberRow = {
  group_id: string;
  agent_id: string;
  role: GroupRole;
  active: number;
  joined_at: string;
  removed_at: string | null;
};
type GroupMessageRow = {
  group_message_id: string;
  group_id: string;
  sender_agent_id: string;
  conversation_id: string;
  body: string;
  membership_snapshot_json: string;
  idempotency_key: string | null;
  created_at: string;
};

function group(row: GroupRow): GroupRecord {
  return {
    groupId: row.group_id,
    displayName: row.display_name,
    ownerAgentId: row.owner_agent_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function member(row: MemberRow): GroupMemberRecord {
  return {
    groupId: row.group_id,
    agentId: row.agent_id,
    role: row.role,
    active: row.active === 1,
    joinedAt: row.joined_at,
    removedAt: row.removed_at,
  };
}

function groupMessage(row: GroupMessageRow): GroupMessageRecord {
  return {
    groupMessageId: row.group_message_id,
    groupId: row.group_id,
    senderAgentId: row.sender_agent_id,
    conversationId: row.conversation_id,
    body: row.body,
    membershipSnapshot: JSON.parse(row.membership_snapshot_json) as string[],
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export class GroupRepository {
  readonly messages: MessageRepository;
  constructor(readonly store: BridgeDatabase) {
    this.messages = new MessageRepository(store);
  }

  create(groupId: string, displayName: string, ownerAgentId: string): GroupRecord {
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(groupId)) throw new Error("invalid stable group ID");
    const now = new Date().toISOString();
    this.store.immediateTransaction(() => {
      this.store.database
        .prepare(
          "INSERT INTO groups(group_id, display_name, owner_agent_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
        )
        .run(groupId, displayName, ownerAgentId, now, now);
      this.store.database
        .prepare(
          "INSERT INTO group_members(group_id, agent_id, role, active, joined_at) VALUES (?, ?, 'owner', 1, ?)",
        )
        .run(groupId, ownerAgentId, now);
    });
    return this.get(groupId);
  }

  get(groupId: string): GroupRecord {
    const row = this.store.database
      .prepare("SELECT * FROM groups WHERE group_id = ?")
      .get(groupId) as GroupRow | undefined;
    if (!row) throw new Error(`unknown group: ${groupId}`);
    return group(row);
  }

  listForAgent(agentId: string): GroupRecord[] {
    return (
      this.store.database
        .prepare(
          `SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.group_id
           WHERE m.agent_id = ? AND m.active = 1 AND g.status <> 'deleted' ORDER BY g.group_id`,
        )
        .all(agentId) as GroupRow[]
    ).map(group);
  }

  members(groupId: string, activeOnly = true): GroupMemberRecord[] {
    return (
      this.store.database
        .prepare(
          `SELECT * FROM group_members WHERE group_id = ? ${activeOnly ? "AND active = 1" : ""}
           ORDER BY agent_id`,
        )
        .all(groupId) as MemberRow[]
    ).map(member);
  }

  member(groupId: string, agentId: string): GroupMemberRecord | null {
    const row = this.store.database
      .prepare("SELECT * FROM group_members WHERE group_id = ? AND agent_id = ?")
      .get(groupId, agentId) as MemberRow | undefined;
    return row ? member(row) : null;
  }

  addMember(groupId: string, agentId: string): GroupMemberRecord {
    const now = new Date().toISOString();
    this.store.database
      .prepare(
        `INSERT INTO group_members(group_id, agent_id, role, active, joined_at, removed_at)
         VALUES (?, ?, 'member', 1, ?, NULL)
         ON CONFLICT(group_id, agent_id) DO UPDATE SET role = 'member', active = 1,
           joined_at = excluded.joined_at, removed_at = NULL`,
      )
      .run(groupId, agentId, now);
    return this.member(groupId, agentId) as GroupMemberRecord;
  }

  removeMember(groupId: string, agentId: string): boolean {
    return (
      this.store.database
        .prepare(
          "UPDATE group_members SET active = 0, removed_at = ? WHERE group_id = ? AND agent_id = ? AND role <> 'owner' AND active = 1",
        )
        .run(new Date().toISOString(), groupId, agentId).changes === 1
    );
  }

  setStatus(groupId: string, status: GroupStatus): GroupRecord {
    const current = this.get(groupId);
    if (current.status === "deleted" && status !== "deleted") {
      throw new Error("deleted group cannot be resumed");
    }
    const changed = this.store.database
      .prepare("UPDATE groups SET status = ?, updated_at = ? WHERE group_id = ?")
      .run(status, new Date().toISOString(), groupId);
    if (changed.changes !== 1) throw new Error(`unknown group: ${groupId}`);
    return this.get(groupId);
  }

  createMessage(input: {
    groupMessageId: string;
    groupId: string;
    senderAgentId: string;
    conversationId: string;
    body: string;
    membershipSnapshot: readonly string[];
    idempotencyKey?: string;
  }): GroupMessageRecord {
    this.store.database
      .prepare(
        `INSERT INTO group_messages(group_message_id, group_id, sender_agent_id, conversation_id,
          body, membership_snapshot_json, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.groupMessageId,
        input.groupId,
        input.senderAgentId,
        input.conversationId,
        input.body,
        JSON.stringify(input.membershipSnapshot),
        input.idempotencyKey ?? null,
        new Date().toISOString(),
      );
    return this.getMessage(input.groupMessageId);
  }

  getMessage(groupMessageId: string): GroupMessageRecord {
    const row = this.store.database
      .prepare("SELECT * FROM group_messages WHERE group_message_id = ?")
      .get(groupMessageId) as GroupMessageRow | undefined;
    if (!row) throw new Error(`unknown group message: ${groupMessageId}`);
    return groupMessage(row);
  }

  findMessageByIdempotency(senderAgentId: string, key: string): GroupMessageRecord | null {
    const row = this.store.database
      .prepare("SELECT * FROM group_messages WHERE sender_agent_id = ? AND idempotency_key = ?")
      .get(senderAgentId, key) as GroupMessageRow | undefined;
    return row ? groupMessage(row) : null;
  }

  addDelivery(
    groupMessageId: string,
    recipientAgentId: string,
    messageId: string,
    sequence: number,
  ): void {
    this.store.database
      .prepare(
        `INSERT INTO group_deliveries(delivery_id, group_message_id, recipient_agent_id,
          message_id, delivery_sequence, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `gdel_${randomUUID()}`,
        groupMessageId,
        recipientAgentId,
        messageId,
        sequence,
        new Date().toISOString(),
      );
  }

  latestDeliveries(groupMessageId: string): Array<{
    recipientAgentId: string;
    sequence: number;
    message: MessageRecord;
  }> {
    const rows = this.store.database
      .prepare(
        `SELECT recipient_agent_id AS recipientAgentId, delivery_sequence AS sequence, message_id AS messageId
         FROM (
           SELECT *, row_number() OVER (PARTITION BY recipient_agent_id ORDER BY delivery_sequence DESC) AS rank
           FROM group_deliveries WHERE group_message_id = ?
         ) WHERE rank = 1 ORDER BY recipient_agent_id`,
      )
      .all(groupMessageId) as Array<{
      recipientAgentId: string;
      sequence: number;
      messageId: string;
    }>;
    return rows.map((row) => ({
      recipientAgentId: row.recipientAgentId,
      sequence: row.sequence,
      message: this.messages.get(row.messageId),
    }));
  }

  explicitReplies(conversationId: string, recipientAgentId: string): MessageRecord[] {
    return (
      this.store.database
        .prepare(
          `SELECT * FROM messages WHERE conversation_id = ? AND recipient_agent_id = ?
           AND kind = 'reply' AND expects_reply = 0 AND status = 'completed'
           ORDER BY created_at, message_id`,
        )
        .all(conversationId, recipientAgentId) as Array<{ message_id: string }>
    ).map((row) => this.messages.get(row.message_id));
  }
}
