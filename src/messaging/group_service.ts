import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../config/index.js";
import type { MessageRecord } from "../store/models.js";
import type { AgentRepository } from "../store/repositories.js";
import type { GroupMessageRecord, GroupRepository } from "../store/groups.js";
import type { DeliveryScheduler } from "./scheduler.js";
import { MessagingError } from "./service.js";

export interface GroupDeliveryStatus {
  readonly recipient: string;
  readonly messageId: string;
  readonly status: "queued" | "running" | "delivered" | "failed" | "expired" | "dead_letter";
  readonly errorCode?: string;
}

export interface GroupMessageStatus {
  readonly groupMessageId: string;
  readonly groupId: string;
  readonly conversationId: string;
  readonly senderAgentId: string;
  readonly deliveries: readonly GroupDeliveryStatus[];
  readonly summary: Readonly<Record<string, number>>;
}

export interface GroupMessagingServiceOptions {
  readonly senderAgentId: string;
  readonly config: BridgeConfig["messaging"];
  readonly agents: AgentRepository;
  readonly groups: GroupRepository;
  readonly scheduler: DeliveryScheduler;
  readonly authorize?: (senderAgentId: string, recipientAgentId: string) => boolean;
}

export class GroupMessagingService {
  readonly #options: GroupMessagingServiceOptions;

  constructor(options: GroupMessagingServiceOptions) {
    this.#options = options;
    this.#options.agents.get(options.senderAgentId);
  }

  listGroups(): Array<{ groupId: string; displayName: string; role: string; memberCount: number }> {
    return this.#options.groups.listForAgent(this.#options.senderAgentId).map((group) => ({
      groupId: group.groupId,
      displayName: group.displayName,
      role:
        this.#options.groups.member(group.groupId, this.#options.senderAgentId)?.role ?? "member",
      memberCount: this.#options.groups.members(group.groupId).length,
    }));
  }

  send(input: {
    readonly groupId: string;
    readonly message: string;
    readonly conversationId?: string;
    readonly idempotencyKey?: string;
  }): GroupMessageStatus {
    this.#requireActiveSender();
    const group = this.#options.groups.get(input.groupId);
    const caller = this.#options.groups.member(group.groupId, this.#options.senderAgentId);
    if (!caller?.active)
      throw new MessagingError("GROUP_FORBIDDEN", "caller is not a group member");
    if (group.status !== "active")
      throw new MessagingError("GROUP_UNAVAILABLE", "group is unavailable");
    if (Buffer.byteLength(input.message, "utf8") > this.#options.config.maxMessageBytes) {
      throw new MessagingError("MESSAGE_TOO_LARGE", "message exceeds configured size limit");
    }
    const duplicate = input.idempotencyKey
      ? this.#options.groups.findMessageByIdempotency(
          this.#options.senderAgentId,
          input.idempotencyKey,
        )
      : null;
    if (duplicate) {
      if (duplicate.groupId !== group.groupId || duplicate.body !== input.message) {
        throw new MessagingError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used for a different group message",
        );
      }
      return this.status(duplicate.groupMessageId);
    }

    const members = this.#options.groups.members(group.groupId);
    const snapshot = members.map((member) => member.agentId);
    const recipients = snapshot.filter((agentId) => agentId !== this.#options.senderAgentId);
    if (recipients.length === 0) throw new MessagingError("GROUP_EMPTY", "group has no recipients");
    if (recipients.length > this.#options.config.maxGroupFanout) {
      throw new MessagingError("GROUP_FANOUT_LIMIT", "group exceeds configured fan-out limit");
    }
    for (const agentId of recipients) {
      const recipient = this.#options.agents.get(agentId);
      if (recipient.status !== "active" || !recipient.acceptsMessages) {
        throw new MessagingError("GROUP_RECIPIENT_UNAVAILABLE", "a group recipient is unavailable");
      }
      if (
        this.#options.authorize &&
        !this.#options.authorize(this.#options.senderAgentId, recipient.agentId)
      ) {
        throw new MessagingError("GROUP_RECIPIENT_FORBIDDEN", "a group recipient is forbidden");
      }
      if (this.#options.groups.messages.queueDepth(agentId) >= this.#options.config.maxQueueDepth) {
        throw new MessagingError("RECIPIENT_QUEUE_FULL", "a recipient queue is full");
      }
    }

    const groupMessageId = `gmsg_${randomUUID()}`;
    const conversationId = input.conversationId ?? `conv_${randomUUID()}`;
    const messageIds: string[] = [];
    this.#options.groups.store.immediateTransaction(() => {
      this.#options.groups.createMessage({
        groupMessageId,
        groupId: group.groupId,
        senderAgentId: this.#options.senderAgentId,
        conversationId,
        body: input.message,
        membershipSnapshot: snapshot,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      for (const agentId of recipients) {
        const recipient = this.#options.agents.get(agentId);
        const messageId = `msg_${randomUUID()}`;
        this.#options.groups.messages.create({
          messageId,
          conversationId,
          senderAgentId: this.#options.senderAgentId,
          recipientAgentId: agentId,
          recipientGeneration: recipient.generation,
          kind: "notice",
          body: input.message,
          expectsReply: false,
          hopCount: 0,
          callChain: [this.#options.senderAgentId],
          expiresAt: new Date(Date.now() + this.#options.config.messageTtlMs).toISOString(),
          groupId: group.groupId,
          groupMessageId,
        });
        this.#options.groups.addDelivery(groupMessageId, agentId, messageId, 1);
        messageIds.push(messageId);
      }
    });
    for (const messageId of messageIds) {
      void this.#options.scheduler.schedule(messageId).catch(() => undefined);
    }
    return this.status(groupMessageId);
  }

  status(groupMessageId: string): GroupMessageStatus {
    const message = this.#visibleMessage(groupMessageId);
    const deliveries = this.#options.groups
      .latestDeliveries(groupMessageId)
      .map((delivery) => this.#delivery(delivery.recipientAgentId, delivery.message));
    return {
      groupMessageId,
      groupId: message.groupId,
      conversationId: message.conversationId,
      senderAgentId: message.senderAgentId,
      deliveries,
      summary: Object.fromEntries(
        [...new Set(deliveries.map((delivery) => delivery.status))].map((status) => [
          status,
          deliveries.filter((delivery) => delivery.status === status).length,
        ]),
      ),
    };
  }

  retry(groupMessageId: string, recipients?: readonly string[]): GroupMessageStatus {
    this.#requireActiveSender();
    const groupMessage = this.#visibleMessage(groupMessageId);
    if (groupMessage.senderAgentId !== this.#options.senderAgentId) {
      throw new MessagingError("GROUP_RETRY_FORBIDDEN", "only the original sender can retry");
    }
    const requested = recipients ? new Set(recipients) : null;
    const scheduled: string[] = [];
    this.#options.groups.store.immediateTransaction(() => {
      for (const delivery of this.#options.groups.latestDeliveries(groupMessageId)) {
        if (requested && !requested.has(delivery.recipientAgentId)) continue;
        if (!new Set(["failed", "dead_letter"]).has(delivery.message.status)) continue;
        const recipient = this.#options.agents.get(delivery.recipientAgentId);
        if (recipient.status !== "active" || !recipient.acceptsMessages) {
          throw new MessagingError(
            "GROUP_RECIPIENT_UNAVAILABLE",
            "a retry recipient is unavailable",
          );
        }
        if (
          this.#options.authorize &&
          !this.#options.authorize(this.#options.senderAgentId, recipient.agentId)
        ) {
          throw new MessagingError("GROUP_RECIPIENT_FORBIDDEN", "a retry recipient is forbidden");
        }
        if (
          this.#options.groups.messages.queueDepth(recipient.agentId) >=
          this.#options.config.maxQueueDepth
        ) {
          throw new MessagingError("RECIPIENT_QUEUE_FULL", "a retry recipient queue is full");
        }
        const messageId = `msg_${randomUUID()}`;
        this.#options.groups.messages.create({
          messageId,
          conversationId: groupMessage.conversationId,
          senderAgentId: groupMessage.senderAgentId,
          recipientAgentId: recipient.agentId,
          recipientGeneration: recipient.generation,
          kind: "notice",
          body: groupMessage.body,
          expectsReply: false,
          hopCount: 0,
          callChain: [groupMessage.senderAgentId],
          expiresAt: new Date(Date.now() + this.#options.config.messageTtlMs).toISOString(),
          groupId: groupMessage.groupId,
          groupMessageId,
        });
        this.#options.groups.addDelivery(
          groupMessageId,
          recipient.agentId,
          messageId,
          delivery.sequence + 1,
        );
        scheduled.push(messageId);
      }
    });
    for (const messageId of scheduled) {
      void this.#options.scheduler.schedule(messageId).catch(() => undefined);
    }
    return this.status(groupMessageId);
  }

  gather(groupMessageId: string): {
    groupMessageId: string;
    synthesizingAgent: string;
    replies: Array<{ fromAgent: string; messageId: string; reply: string }>;
  } {
    const groupMessage = this.#visibleMessage(groupMessageId);
    if (groupMessage.senderAgentId !== this.#options.senderAgentId) {
      throw new MessagingError("GROUP_GATHER_FORBIDDEN", "only the original sender can gather");
    }
    return {
      groupMessageId,
      synthesizingAgent: this.#options.senderAgentId,
      replies: this.#options.groups
        .explicitReplies(groupMessage.conversationId, this.#options.senderAgentId)
        .filter((reply) => groupMessage.membershipSnapshot.includes(reply.senderAgentId))
        .map((reply) => ({
          fromAgent: reply.senderAgentId,
          messageId: reply.messageId,
          reply: reply.body,
        })),
    };
  }

  #visibleMessage(groupMessageId: string): GroupMessageRecord {
    const message = this.#options.groups.getMessage(groupMessageId);
    if (
      message.senderAgentId !== this.#options.senderAgentId &&
      !message.membershipSnapshot.includes(this.#options.senderAgentId)
    ) {
      throw new MessagingError("GROUP_MESSAGE_UNKNOWN", "group message is not visible");
    }
    return message;
  }

  #requireActiveSender(): void {
    const sender = this.#options.agents.get(this.#options.senderAgentId);
    if (sender.status !== "active" || !sender.acceptsMessages) {
      throw new MessagingError("SENDER_UNAVAILABLE", "sender is unavailable");
    }
  }

  #delivery(recipient: string, message: MessageRecord): GroupDeliveryStatus {
    const status: GroupDeliveryStatus["status"] =
      message.status === "completed"
        ? "delivered"
        : message.errorCode === "MESSAGE_EXPIRED"
          ? "expired"
          : message.status === "dispatching" || message.status === "running"
            ? "running"
            : message.status;
    return {
      recipient,
      messageId: message.messageId,
      status,
      ...(message.errorCode ? { errorCode: message.errorCode } : {}),
    };
  }
}
