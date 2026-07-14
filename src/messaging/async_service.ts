import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../config/index.js";
import type { MessageKind, MessageRecord } from "../store/models.js";
import type { AgentRepository, MessageRepository } from "../store/repositories.js";
import type { DeliveryScheduler } from "./scheduler.js";
import { MessagingError } from "./service.js";

export type AsyncDeliveryStatus =
  "queued" | "running" | "delivered" | "failed" | "expired" | "dead_letter";

export interface SendMessageInput {
  readonly recipient: string;
  readonly message: string;
  readonly kind?: "request" | "notice";
  readonly conversationId?: string;
  readonly parentMessageId?: string;
  readonly idempotencyKey?: string;
}

export interface AsyncMessageStatus {
  readonly status: AsyncDeliveryStatus;
  readonly messageId: string;
  readonly conversationId: string;
  readonly recipient: string;
  readonly targetThreadId?: string;
  readonly targetTurnId?: string;
  readonly errorCode?: string;
  readonly error?: string;
}

export interface InboxItem {
  readonly messageId: string;
  readonly conversationId: string;
  readonly parentMessageId?: string;
  readonly fromAgent: string;
  readonly kind: MessageKind;
  readonly message: string;
  readonly createdAt: string;
  readonly deliveredAt: string;
  readonly read: boolean;
  readonly acknowledged: boolean;
}

export interface AsyncMessagingServiceOptions {
  readonly senderAgentId: string;
  readonly config: BridgeConfig["messaging"];
  readonly agents: AgentRepository;
  readonly messages: MessageRepository;
  readonly scheduler: DeliveryScheduler;
  readonly authorize?: (senderAgentId: string, recipientAgentId: string) => boolean;
}

export class AsyncMessagingService {
  readonly #options: AsyncMessagingServiceOptions;

  constructor(options: AsyncMessagingServiceOptions) {
    this.#options = options;
    this.#options.agents.get(options.senderAgentId);
  }

  send(input: SendMessageInput): AsyncMessageStatus {
    return this.#create(input, input.kind ?? "notice");
  }

  reply(input: {
    readonly messageId: string;
    readonly message: string;
    readonly idempotencyKey?: string;
  }): AsyncMessageStatus {
    const original = this.#options.messages.get(input.messageId);
    if (original.expectsReply || original.recipientAgentId !== this.#options.senderAgentId) {
      throw new MessagingError("MESSAGE_NOT_VISIBLE", "message is not available for reply");
    }
    return this.#create(
      {
        recipient: original.senderAgentId,
        message: input.message,
        conversationId: original.conversationId,
        parentMessageId: original.messageId,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      },
      "reply",
    );
  }

  readInbox(input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly markRead?: boolean;
  }): { messages: InboxItem[]; nextCursor?: string } {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    let records = this.#options.messages.inbox(this.#options.senderAgentId, input.cursor, limit);
    if (input.markRead !== false && records.length > 0) {
      this.#options.messages.markInboxRead(
        records.map((record) => record.messageId),
        this.#options.senderAgentId,
      );
      records = records.map((record) => this.#options.messages.get(record.messageId));
    }
    const messages = records.map((record) => this.#inboxItem(record));
    const nextCursor = records.length === limit ? records.at(-1)?.messageId : undefined;
    return { messages, ...(nextCursor ? { nextCursor } : {}) };
  }

  acknowledge(messageId: string): InboxItem {
    return this.#inboxItem(
      this.#options.messages.acknowledge(messageId, this.#options.senderAgentId),
    );
  }

  status(messageId: string): AsyncMessageStatus | { status: "unknown"; messageId: string } {
    let record: MessageRecord;
    try {
      record = this.#options.messages.get(messageId);
    } catch {
      return { status: "unknown", messageId };
    }
    if (
      record.expectsReply ||
      !new Set([record.senderAgentId, record.recipientAgentId]).has(this.#options.senderAgentId)
    ) {
      return { status: "unknown", messageId };
    }
    return this.#status(record);
  }

  #create(input: SendMessageInput, kind: MessageKind): AsyncMessageStatus {
    const sender = this.#options.agents.get(this.#options.senderAgentId);
    const recipient = this.#options.agents.get(input.recipient);
    if (sender.status !== "active") {
      throw new MessagingError("SENDER_UNAVAILABLE", "sender agent is unavailable");
    }
    if (recipient.status !== "active" || !recipient.acceptsMessages) {
      throw new MessagingError("RECIPIENT_UNAVAILABLE", "recipient agent is unavailable");
    }
    if (sender.agentId === recipient.agentId) {
      throw new MessagingError("SELF_MESSAGE_DENIED", "self messaging is not allowed");
    }
    if (this.#options.authorize && !this.#options.authorize(sender.agentId, recipient.agentId)) {
      throw new MessagingError(
        "RECIPIENT_FORBIDDEN",
        "sender is not authorized for this recipient",
      );
    }
    if (Buffer.byteLength(input.message, "utf8") > this.#options.config.maxMessageBytes) {
      throw new MessagingError("MESSAGE_TOO_LARGE", "message exceeds configured size limit");
    }
    let record = input.idempotencyKey
      ? this.#options.messages.findByIdempotency(sender.agentId, input.idempotencyKey)
      : null;
    if (record) {
      if (
        record.expectsReply ||
        record.recipientAgentId !== recipient.agentId ||
        record.body !== input.message
      ) {
        throw new MessagingError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used for a different request",
        );
      }
    } else {
      if (
        this.#options.messages.queueDepth(recipient.agentId) >= this.#options.config.maxQueueDepth
      ) {
        throw new MessagingError("RECIPIENT_QUEUE_FULL", "recipient queue is full");
      }
      record = this.#options.messages.create({
        messageId: `msg_${randomUUID()}`,
        conversationId: input.conversationId ?? `conv_${randomUUID()}`,
        ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
        senderAgentId: sender.agentId,
        recipientAgentId: recipient.agentId,
        recipientGeneration: recipient.generation,
        kind,
        body: input.message,
        expectsReply: false,
        hopCount: 0,
        callChain: [sender.agentId],
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        expiresAt: new Date(Date.now() + this.#options.config.messageTtlMs).toISOString(),
      });
    }
    void this.#options.scheduler.schedule(record.messageId).catch(() => undefined);
    return this.#status(record);
  }

  #status(record: MessageRecord): AsyncMessageStatus {
    const status: AsyncDeliveryStatus =
      record.status === "completed"
        ? "delivered"
        : record.errorCode === "MESSAGE_EXPIRED"
          ? "expired"
          : record.status === "dispatching" || record.status === "running"
            ? "running"
            : record.status;
    return {
      status,
      messageId: record.messageId,
      conversationId: record.conversationId,
      recipient: record.recipientAgentId,
      ...(record.targetThreadId ? { targetThreadId: record.targetThreadId } : {}),
      ...(record.targetTurnId ? { targetTurnId: record.targetTurnId } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...(record.errorMessage ? { error: record.errorMessage } : {}),
    };
  }

  #inboxItem(record: MessageRecord): InboxItem {
    if (!record.deliveredAt) throw new Error("delivered inbox message has no delivery timestamp");
    return {
      messageId: record.messageId,
      conversationId: record.conversationId,
      ...(record.parentMessageId ? { parentMessageId: record.parentMessageId } : {}),
      fromAgent: record.senderAgentId,
      kind: record.kind,
      message: record.body,
      createdAt: record.createdAt,
      deliveredAt: record.deliveredAt,
      read: record.inboxReadAt !== null,
      acknowledged: record.acknowledgedAt !== null,
    };
  }
}
