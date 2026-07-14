import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BridgeDatabase } from "./database.js";
import {
  assertMessageTransition,
  type AgentRecord,
  type AgentStatus,
  type MessageKind,
  type MessageRecord,
  type MessageStatus,
} from "./models.js";

type AgentRow = {
  agent_id: string;
  display_name: string;
  active_thread_id: string;
  generation: number;
  workspace: string;
  accepts_messages: number;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  message_id: string;
  conversation_id: string;
  parent_message_id: string | null;
  sender_agent_id: string;
  recipient_agent_id: string;
  recipient_generation: number;
  kind: MessageKind;
  body: string;
  expects_reply: number;
  hop_count: number;
  call_chain_json: string;
  status: MessageStatus;
  created_at: string;
  delivered_at: string | null;
  completed_at: string | null;
  target_thread_id: string | null;
  target_turn_id: string | null;
  reply_body: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  idempotency_key: string | null;
  next_attempt_at: string | null;
  expires_at: string | null;
  inbox_read_at: string | null;
  acknowledged_at: string | null;
  group_id: string | null;
  group_message_id: string | null;
};

function agent(row: AgentRow): AgentRecord {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    activeThreadId: row.active_thread_id,
    generation: row.generation,
    workspace: row.workspace,
    acceptsMessages: row.accepts_messages === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function message(row: MessageRow): MessageRecord {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    parentMessageId: row.parent_message_id,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    recipientGeneration: row.recipient_generation,
    kind: row.kind,
    body: row.body,
    expectsReply: row.expects_reply === 1,
    hopCount: row.hop_count,
    callChain: JSON.parse(row.call_chain_json) as string[],
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    completedAt: row.completed_at,
    targetThreadId: row.target_thread_id,
    targetTurnId: row.target_turn_id,
    replyBody: row.reply_body,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attemptCount: row.attempt_count,
    idempotencyKey: row.idempotency_key,
    nextAttemptAt: row.next_attempt_at,
    expiresAt: row.expires_at,
    inboxReadAt: row.inbox_read_at,
    acknowledgedAt: row.acknowledged_at,
    groupId: row.group_id,
    groupMessageId: row.group_message_id,
  };
}

export class AgentRepository {
  constructor(readonly store: BridgeDatabase) {}

  register(input: {
    agentId: string;
    displayName: string;
    threadId: string;
    workspace: string;
  }): AgentRecord {
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(input.agentId)) throw new Error("invalid stable agent ID");
    const now = new Date().toISOString();
    this.store.immediateTransaction(() => {
      this.store.database
        .prepare(
          `INSERT INTO agents(agent_id, display_name, active_thread_id, generation, workspace, accepts_messages, status, created_at, updated_at)
           VALUES (@agentId, @displayName, @threadId, 1, @workspace, 1, 'active', @now, @now)`,
        )
        .run({ ...input, now });
      this.store.database
        .prepare(
          `INSERT INTO agent_thread_generations(agent_id, generation, thread_id, status, created_at)
           VALUES (?, 1, ?, 'active', ?)`,
        )
        .run(input.agentId, input.threadId, now);
    });
    return this.get(input.agentId);
  }

  get(agentId: string): AgentRecord {
    const row = this.store.database
      .prepare("SELECT * FROM agents WHERE agent_id = ?")
      .get(agentId) as AgentRow | undefined;
    if (!row) throw new Error(`unknown agent: ${agentId}`);
    return agent(row);
  }

  list(): AgentRecord[] {
    return (
      this.store.database.prepare("SELECT * FROM agents ORDER BY agent_id").all() as AgentRow[]
    ).map(agent);
  }

  discoverByDisplayName(search: string): AgentRecord[] {
    return (
      this.store.database
        .prepare("SELECT * FROM agents WHERE display_name LIKE ? ORDER BY agent_id")
        .all(`%${search}%`) as AgentRow[]
    ).map(agent);
  }

  setStatus(agentId: string, status: AgentStatus): AgentRecord {
    const current = this.get(agentId);
    if (["disabled", "superseded"].includes(current.status) && status !== current.status) {
      throw new Error(`${current.status} agent cannot be resumed; replace or register explicitly`);
    }
    this.store.immediateTransaction(() => {
      const now = new Date().toISOString();
      const result = this.store.database
        .prepare(
          "UPDATE agents SET status = ?, accepts_messages = ?, updated_at = ? WHERE agent_id = ?",
        )
        .run(status, status === "active" ? 1 : 0, now, agentId);
      if (result.changes !== 1) throw new Error(`unknown agent: ${agentId}`);
      if (status === "superseded") {
        this.store.database
          .prepare(
            "UPDATE agent_thread_generations SET status = 'superseded', superseded_at = ? WHERE agent_id = ? AND generation = ?",
          )
          .run(now, agentId, current.generation);
      }
    });
    return this.get(agentId);
  }

  replace(
    agentId: string,
    newThreadId: string,
    workspace: string,
    expectedGeneration: number,
  ): AgentRecord {
    this.store.immediateTransaction(() => {
      const current = this.get(agentId);
      if (current.generation !== expectedGeneration) throw new Error("agent generation changed");
      const now = new Date().toISOString();
      this.store.database
        .prepare(
          "UPDATE agent_thread_generations SET status = 'superseded', superseded_at = ? WHERE agent_id = ? AND generation = ? AND status = 'active'",
        )
        .run(now, agentId, expectedGeneration);
      this.store.database
        .prepare(
          "INSERT INTO agent_thread_generations(agent_id, generation, thread_id, status, created_at) VALUES (?, ?, ?, 'active', ?)",
        )
        .run(agentId, expectedGeneration + 1, newThreadId, now);
      const changed = this.store.database
        .prepare(
          "UPDATE agents SET active_thread_id = ?, generation = ?, workspace = ?, status = 'active', accepts_messages = 1, updated_at = ? WHERE agent_id = ? AND generation = ?",
        )
        .run(newThreadId, expectedGeneration + 1, workspace, now, agentId, expectedGeneration);
      if (changed.changes !== 1) throw new Error("agent generation changed during replacement");
    });
    return this.get(agentId);
  }
}

export class MessageRepository {
  constructor(readonly store: BridgeDatabase) {}

  create(input: {
    messageId: string;
    conversationId: string;
    parentMessageId?: string;
    senderAgentId: string;
    recipientAgentId: string;
    recipientGeneration: number;
    kind: MessageKind;
    body: string;
    expectsReply: boolean;
    hopCount: number;
    callChain: readonly string[];
    idempotencyKey?: string;
    expiresAt?: string;
    groupId?: string;
    groupMessageId?: string;
  }): MessageRecord {
    return this.store.immediateTransaction(() => {
      const now = new Date().toISOString();
      const inserted = this.store.database
        .prepare(
          `INSERT INTO messages(message_id, conversation_id, parent_message_id, sender_agent_id, recipient_agent_id,
            recipient_generation, kind, body, expects_reply, hop_count, call_chain_json, status, created_at,
            idempotency_key, expires_at, group_id, group_message_id)
           VALUES (@messageId, @conversationId, @parentMessageId, @senderAgentId, @recipientAgentId,
            @recipientGeneration, @kind, @body, @expectsReply, @hopCount, @callChainJson, 'queued', @createdAt,
            @idempotencyKey, @expiresAt, @groupId, @groupMessageId)
           ON CONFLICT(sender_agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        )
        .run({
          ...input,
          parentMessageId: input.parentMessageId ?? null,
          expectsReply: input.expectsReply ? 1 : 0,
          callChainJson: JSON.stringify(input.callChain),
          createdAt: now,
          idempotencyKey: input.idempotencyKey ?? null,
          expiresAt: input.expiresAt ?? null,
          groupId: input.groupId ?? null,
          groupMessageId: input.groupMessageId ?? null,
        });
      if (inserted.changes === 0 && input.idempotencyKey) {
        const existing = this.findByIdempotency(input.senderAgentId, input.idempotencyKey);
        if (!existing) throw new Error("idempotency conflict could not be resolved");
        if (existing.recipientAgentId !== input.recipientAgentId || existing.body !== input.body) {
          throw new Error("idempotency key was already used for a different request");
        }
        return existing;
      }
      if (input.expectsReply) {
        this.store.database
          .prepare(
            "INSERT INTO dependency_edges(message_id, from_agent_id, to_agent_id, status, created_at) VALUES (?, ?, ?, 'active', ?)",
          )
          .run(input.messageId, input.senderAgentId, input.recipientAgentId, now);
      }
      return this.get(input.messageId);
    });
  }

  findByIdempotency(senderAgentId: string, idempotencyKey: string): MessageRecord | null {
    const row = this.store.database
      .prepare("SELECT * FROM messages WHERE sender_agent_id = ? AND idempotency_key = ?")
      .get(senderAgentId, idempotencyKey) as MessageRow | undefined;
    return row ? message(row) : null;
  }

  queueHead(recipientAgentId: string, generation: number): MessageRecord | null {
    const row = this.store.database
      .prepare(
        `SELECT * FROM messages
         WHERE recipient_agent_id = ? AND recipient_generation = ?
           AND status IN ('queued', 'dispatching', 'running')
         ORDER BY created_at, message_id LIMIT 1`,
      )
      .get(recipientAgentId, generation) as MessageRow | undefined;
    return row ? message(row) : null;
  }

  queueDepth(recipientAgentId: string): number {
    const row = this.store.database
      .prepare(
        "SELECT count(*) AS count FROM messages WHERE recipient_agent_id = ? AND status IN ('queued', 'dispatching', 'running')",
      )
      .get(recipientAgentId) as { count: number };
    return row.count;
  }

  unfinished(): MessageRecord[] {
    return (
      this.store.database
        .prepare(
          "SELECT * FROM messages WHERE status IN ('queued', 'dispatching', 'running') ORDER BY created_at, message_id",
        )
        .all() as MessageRow[]
    ).map(message);
  }

  inbox(
    recipientAgentId: string,
    afterMessageId: string | undefined,
    limit: number,
  ): MessageRecord[] {
    let afterCreatedAt = "";
    let afterId = "";
    if (afterMessageId) {
      const cursor = this.get(afterMessageId);
      if (cursor.recipientAgentId !== recipientAgentId || cursor.expectsReply) {
        throw new Error("invalid inbox cursor");
      }
      afterCreatedAt = cursor.createdAt;
      afterId = cursor.messageId;
    }
    return (
      this.store.database
        .prepare(
          `SELECT * FROM messages
           WHERE recipient_agent_id = ? AND expects_reply = 0 AND status = 'completed'
             AND (created_at > ? OR (created_at = ? AND message_id > ?))
           ORDER BY created_at, message_id LIMIT ?`,
        )
        .all(recipientAgentId, afterCreatedAt, afterCreatedAt, afterId, limit) as MessageRow[]
    ).map(message);
  }

  markInboxRead(messageIds: readonly string[], recipientAgentId: string): void {
    const update = this.store.database.prepare(
      `UPDATE messages SET inbox_read_at = COALESCE(inbox_read_at, ?)
       WHERE message_id = ? AND recipient_agent_id = ? AND expects_reply = 0 AND status = 'completed'`,
    );
    this.store.immediateTransaction(() => {
      const now = new Date().toISOString();
      for (const messageId of messageIds) update.run(now, messageId, recipientAgentId);
    });
  }

  acknowledge(messageId: string, recipientAgentId: string): MessageRecord {
    const result = this.store.database
      .prepare(
        `UPDATE messages SET acknowledged_at = COALESCE(acknowledged_at, ?),
           inbox_read_at = COALESCE(inbox_read_at, ?)
         WHERE message_id = ? AND recipient_agent_id = ? AND expects_reply = 0 AND status = 'completed'`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), messageId, recipientAgentId);
    if (result.changes !== 1) throw new Error("asynchronous message is not acknowledgeable");
    return this.get(messageId);
  }

  closeDependency(messageId: string): void {
    this.store.database
      .prepare(
        "UPDATE dependency_edges SET status = 'closed', closed_at = ? WHERE message_id = ? AND status = 'active'",
      )
      .run(new Date().toISOString(), messageId);
  }

  wouldCreateCycle(fromAgentId: string, toAgentId: string): boolean {
    if (fromAgentId === toAgentId) return true;
    const row = this.store.database
      .prepare(
        `WITH RECURSIVE reachable(agent_id) AS (
           SELECT to_agent_id FROM dependency_edges WHERE from_agent_id = ? AND status = 'active'
           UNION
           SELECT edge.to_agent_id FROM dependency_edges edge JOIN reachable ON edge.from_agent_id = reachable.agent_id
           WHERE edge.status = 'active'
         ) SELECT 1 AS found FROM reachable WHERE agent_id = ? LIMIT 1`,
      )
      .get(toAgentId, fromAgentId) as { found: number } | undefined;
    return Boolean(row);
  }

  get(messageId: string): MessageRecord {
    const row = this.store.database
      .prepare("SELECT * FROM messages WHERE message_id = ?")
      .get(messageId) as MessageRow | undefined;
    if (!row) throw new Error(`unknown message: ${messageId}`);
    return message(row);
  }

  transition(
    messageId: string,
    to: MessageStatus,
    fields: Record<string, string | number | null> = {},
  ): MessageRecord {
    return this.store.immediateTransaction(() => {
      const current = this.get(messageId);
      assertMessageTransition(current.status, to);
      const allowed = new Set([
        "delivered_at",
        "completed_at",
        "target_thread_id",
        "target_turn_id",
        "reply_body",
        "error_code",
        "error_message",
        "attempt_count",
        "next_attempt_at",
      ]);
      const entries = Object.entries(fields);
      if (entries.some(([key]) => !allowed.has(key)))
        throw new Error("unsupported message update field");
      const assignments = ["status = ?", ...entries.map(([key]) => `${key} = ?`)];
      this.store.database
        .prepare(
          `UPDATE messages SET ${assignments.join(", ")} WHERE message_id = ? AND status = ?`,
        )
        .run(to, ...entries.map(([, value]) => value), messageId, current.status);
      return this.get(messageId);
    });
  }

  recoverToQueued(messageId: string, nextAttemptAt: string | null = null): MessageRecord {
    const current = this.get(messageId);
    if (!new Set<MessageStatus>(["dispatching", "running"]).has(current.status)) return current;
    return this.transition(messageId, "queued", { next_attempt_at: nextAttemptAt });
  }

  scheduleRetry(messageId: string, nextAttemptAt: string): MessageRecord {
    const current = this.get(messageId);
    if (current.status === "queued") {
      this.store.database
        .prepare(
          "UPDATE messages SET next_attempt_at = ? WHERE message_id = ? AND status = 'queued'",
        )
        .run(nextAttemptAt, messageId);
      return this.get(messageId);
    }
    return this.transition(messageId, "queued", { next_attempt_at: nextAttemptAt });
  }

  completeRecovered(
    messageId: string,
    threadId: string,
    turnId: string,
    reply: string | null,
  ): MessageRecord {
    return this.store.immediateTransaction(() => {
      const result = this.store.database
        .prepare(
          `UPDATE messages SET status = 'completed', delivered_at = COALESCE(delivered_at, ?), completed_at = ?,
             target_thread_id = ?, target_turn_id = ?, reply_body = ?, next_attempt_at = NULL
           WHERE message_id = ? AND status IN ('queued', 'dispatching', 'running')`,
        )
        .run(
          new Date().toISOString(),
          new Date().toISOString(),
          threadId,
          turnId,
          reply,
          messageId,
        );
      if (result.changes !== 1) throw new Error("message is not recoverable");
      this.closeDependency(messageId);
      return this.get(messageId);
    });
  }

  failTerminal(messageId: string, errorCode: string, errorMessage: string): MessageRecord {
    return this.store.immediateTransaction(() => {
      const result = this.store.database
        .prepare(
          `UPDATE messages SET status = 'failed', completed_at = ?, error_code = ?, error_message = ?, next_attempt_at = NULL
           WHERE message_id = ? AND status IN ('queued', 'dispatching', 'running')`,
        )
        .run(new Date().toISOString(), errorCode, errorMessage, messageId);
      if (result.changes !== 1) return this.get(messageId);
      this.closeDependency(messageId);
      return this.get(messageId);
    });
  }

  deadLetter(messageId: string, errorCode: string, errorMessage: string): MessageRecord {
    return this.store.immediateTransaction(() => {
      const result = this.store.database
        .prepare(
          `UPDATE messages SET status = 'dead_letter', completed_at = ?, error_code = ?,
             error_message = ?, next_attempt_at = NULL
           WHERE message_id = ? AND status IN ('queued', 'dispatching', 'running')`,
        )
        .run(new Date().toISOString(), errorCode, errorMessage, messageId);
      if (result.changes !== 1) return this.get(messageId);
      this.closeDependency(messageId);
      return this.get(messageId);
    });
  }

  startAttempt(messageId: string, appServerRequestId?: string): string {
    return this.store.immediateTransaction(() => {
      const current = this.get(messageId);
      const attemptNumber = current.attemptCount + 1;
      const attemptId = `attempt_${randomUUID()}`;
      this.store.database
        .prepare("UPDATE messages SET attempt_count = ? WHERE message_id = ?")
        .run(attemptNumber, messageId);
      this.store.database
        .prepare(
          "INSERT INTO delivery_attempts(attempt_id, message_id, attempt_number, started_at, app_server_request_id) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          attemptId,
          messageId,
          attemptNumber,
          new Date().toISOString(),
          appServerRequestId ?? null,
        );
      return attemptId;
    });
  }

  finishAttempt(attemptId: string, result: string, targetTurnId?: string, error?: string): void {
    const update = this.store.database
      .prepare(
        "UPDATE delivery_attempts SET finished_at = ?, target_turn_id = ?, result = ?, error = ? WHERE attempt_id = ? AND finished_at IS NULL",
      )
      .run(new Date().toISOString(), targetTurnId ?? null, result, error ?? null, attemptId);
    if (update.changes !== 1) throw new Error(`unknown or finished attempt: ${attemptId}`);
  }
}

export interface AclRuleRecord {
  readonly senderAgentId: string;
  readonly recipientAgentId: string;
  readonly allowed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type AclRuleRow = {
  sender_agent_id: string;
  recipient_agent_id: string;
  allowed: number;
  created_at: string;
  updated_at: string;
};

function aclRule(row: AclRuleRow): AclRuleRecord {
  return {
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    allowed: row.allowed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AclRepository {
  constructor(readonly store: BridgeDatabase) {}

  isAllowed(senderAgentId: string, recipientAgentId: string, defaultAllow: boolean): boolean {
    const row = this.store.database
      .prepare("SELECT * FROM agent_acl WHERE sender_agent_id = ? AND recipient_agent_id = ?")
      .get(senderAgentId, recipientAgentId) as AclRuleRow | undefined;
    return row ? row.allowed === 1 : defaultAllow;
  }

  set(senderAgentId: string, recipientAgentId: string, allowed: boolean): AclRuleRecord {
    const now = new Date().toISOString();
    this.store.database
      .prepare(
        `INSERT INTO agent_acl(sender_agent_id, recipient_agent_id, allowed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sender_agent_id, recipient_agent_id) DO UPDATE SET
           allowed = excluded.allowed, updated_at = excluded.updated_at`,
      )
      .run(senderAgentId, recipientAgentId, allowed ? 1 : 0, now, now);
    return this.get(senderAgentId, recipientAgentId);
  }

  get(senderAgentId: string, recipientAgentId: string): AclRuleRecord {
    const row = this.store.database
      .prepare("SELECT * FROM agent_acl WHERE sender_agent_id = ? AND recipient_agent_id = ?")
      .get(senderAgentId, recipientAgentId) as AclRuleRow | undefined;
    if (!row) throw new Error("ACL rule not found");
    return aclRule(row);
  }

  list(): AclRuleRecord[] {
    return (
      this.store.database
        .prepare("SELECT * FROM agent_acl ORDER BY sender_agent_id, recipient_agent_id")
        .all() as AclRuleRow[]
    ).map(aclRule);
  }

  remove(senderAgentId: string, recipientAgentId: string): boolean {
    return (
      this.store.database
        .prepare("DELETE FROM agent_acl WHERE sender_agent_id = ? AND recipient_agent_id = ?")
        .run(senderAgentId, recipientAgentId).changes === 1
    );
  }
}

export interface AuditEventRecord {
  readonly auditId: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly messageId: string | null;
  readonly conversationId: string | null;
  readonly senderAgentId: string | null;
  readonly recipientAgentId: string | null;
  readonly recipientGeneration: number | null;
  readonly targetThreadId: string | null;
  readonly targetTurnId: string | null;
  readonly status: string | null;
  readonly attemptCount: number | null;
}

export class AuditRepository {
  constructor(readonly store: BridgeDatabase) {}

  forMessage(messageId: string): AuditEventRecord[] {
    return this.store.database
      .prepare(
        `SELECT audit_id AS auditId, event_type AS eventType, occurred_at AS occurredAt,
          message_id AS messageId, conversation_id AS conversationId, sender_agent_id AS senderAgentId,
          recipient_agent_id AS recipientAgentId, recipient_generation AS recipientGeneration,
          target_thread_id AS targetThreadId, target_turn_id AS targetTurnId, status,
          attempt_count AS attemptCount
         FROM audit_events WHERE message_id = ? ORDER BY audit_id`,
      )
      .all(messageId) as AuditEventRecord[];
  }
}

export class RecipientLeaseRepository {
  constructor(readonly store: BridgeDatabase) {}

  acquire(
    threadId: string,
    ownerInstanceId: string,
    durationMs: number,
    now = Date.now(),
  ): string | null {
    return this.store.immediateTransaction(() => {
      this.store.database
        .prepare("DELETE FROM recipient_leases WHERE expires_at <= ?")
        .run(new Date(now).toISOString());
      const token = `lease_${randomUUID()}`;
      const result = this.store.database
        .prepare(
          "INSERT OR IGNORE INTO recipient_leases(recipient_thread_id, owner_instance_id, lease_token, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          threadId,
          ownerInstanceId,
          token,
          new Date(now).toISOString(),
          new Date(now + durationMs).toISOString(),
        );
      return result.changes === 1 ? token : null;
    });
  }

  renew(threadId: string, token: string, durationMs: number, now = Date.now()): boolean {
    const result = this.store.database
      .prepare(
        "UPDATE recipient_leases SET expires_at = ? WHERE recipient_thread_id = ? AND lease_token = ? AND expires_at > ?",
      )
      .run(new Date(now + durationMs).toISOString(), threadId, token, new Date(now).toISOString());
    return result.changes === 1;
  }

  release(threadId: string, token: string): boolean {
    return (
      this.store.database
        .prepare("DELETE FROM recipient_leases WHERE recipient_thread_id = ? AND lease_token = ?")
        .run(threadId, token).changes === 1
    );
  }
}

export type SqliteDatabase = Database.Database;
