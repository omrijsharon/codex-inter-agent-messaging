import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AppServerClient } from "../app_server/client.js";
import type { BridgeConfig } from "../config/index.js";
import type { AgentRecord, MessageRecord } from "../store/models.js";
import type {
  AgentRepository,
  MessageRepository,
  RecipientLeaseRepository,
} from "../store/repositories.js";
import { DeliveryScheduler } from "./scheduler.js";

export interface AskAgentInput {
  readonly recipient: string;
  readonly message: string;
  readonly conversationId?: string;
  readonly parentMessageId?: string;
  readonly idempotencyKey?: string;
  readonly waitMs?: number;
  readonly callChain?: readonly string[];
}

export type AskAgentResult =
  | {
      readonly status: "completed";
      readonly messageId: string;
      readonly conversationId: string;
      readonly fromAgent: string;
      readonly reply: string;
      readonly targetThreadId: string;
      readonly targetTurnId: string;
    }
  | { readonly status: "pending"; readonly messageId: string; readonly conversationId: string }
  | {
      readonly status: "failed";
      readonly messageId: string;
      readonly conversationId: string;
      readonly errorCode: string;
      readonly error: string;
    };

export interface MessagingServiceOptions {
  readonly senderAgentId: string;
  readonly instanceId: string;
  readonly config: BridgeConfig["messaging"] & { turnTimeoutMs: number };
  readonly appServer: AppServerClient;
  readonly agents: AgentRepository;
  readonly messages: MessageRepository;
  readonly leases: RecipientLeaseRepository;
  readonly authorize?: (senderAgentId: string, recipientAgentId: string) => boolean;
  readonly scheduler?: DeliveryScheduler;
}

export class MessagingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MessagingError";
    this.code = code;
  }
}

export class MessagingService {
  readonly #options: MessagingServiceOptions;
  readonly #scheduler: DeliveryScheduler;

  constructor(options: MessagingServiceOptions) {
    this.#options = options;
    this.#options.agents.get(options.senderAgentId);
    this.#scheduler =
      options.scheduler ??
      new DeliveryScheduler({
        instanceId: options.instanceId,
        config: options.config,
        appServer: options.appServer,
        agents: options.agents,
        messages: options.messages,
        leases: options.leases,
      });
  }

  start(): void {
    for (const record of this.#options.messages.unfinished()) {
      void this.#scheduler.schedule(record.messageId);
    }
  }

  listAgents(): AgentRecord[] {
    return this.#options.agents
      .list()
      .filter((agent) => agent.status === "active" && agent.acceptsMessages)
      .map((agent) => ({ ...agent, workspace: "[REDACTED]" }));
  }

  async ask(input: AskAgentInput, signal?: AbortSignal): Promise<AskAgentResult> {
    const sender = this.#options.agents.get(this.#options.senderAgentId);
    const recipient = this.#options.agents.get(input.recipient);
    this.#validate(sender, recipient, input);

    const callChain = input.callChain ?? [sender.agentId];
    let record = input.idempotencyKey
      ? this.#options.messages.findByIdempotency(sender.agentId, input.idempotencyKey)
      : null;
    if (record) {
      if (record.recipientAgentId !== recipient.agentId || record.body !== input.message) {
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
      if (
        callChain.includes(recipient.agentId) ||
        this.#options.messages.wouldCreateCycle(sender.agentId, recipient.agentId)
      ) {
        throw new MessagingError("CALL_CYCLE", "request would create an active call cycle");
      }
      try {
        record = this.#options.messages.create({
          messageId: `msg_${randomUUID()}`,
          conversationId: input.conversationId ?? `conv_${randomUUID()}`,
          ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
          senderAgentId: sender.agentId,
          recipientAgentId: recipient.agentId,
          recipientGeneration: recipient.generation,
          kind: "request",
          body: input.message,
          expectsReply: true,
          hopCount: callChain.length - 1,
          callChain,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          expiresAt: new Date(Date.now() + this.#options.config.messageTtlMs).toISOString(),
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("idempotency key")) {
          throw new MessagingError("IDEMPOTENCY_CONFLICT", error.message);
        }
        throw error;
      }
    }

    const delivery = this.#scheduler.schedule(record.messageId);
    const waitMs = input.waitMs ?? this.#options.config.synchronousWaitMs;
    const outcome = await Promise.race([
      delivery,
      delay(waitMs).then(() => null),
      ...(signal
        ? [
            new Promise<null>((resolve) => {
              if (signal.aborted) resolve(null);
              else signal.addEventListener("abort", () => resolve(null), { once: true });
            }),
          ]
        : []),
    ]);
    return outcome
      ? this.#result(outcome)
      : this.#result(this.#options.messages.get(record.messageId));
  }

  status(messageId: string): AskAgentResult | { status: "unknown"; messageId: string } {
    let record: MessageRecord;
    try {
      record = this.#options.messages.get(messageId);
    } catch {
      return { status: "unknown", messageId };
    }
    if (record.senderAgentId !== this.#options.senderAgentId) {
      return { status: "unknown", messageId };
    }
    return this.#result(record);
  }

  #validate(sender: AgentRecord, recipient: AgentRecord, input: AskAgentInput): void {
    if (sender.status !== "active") {
      throw new MessagingError("SENDER_UNAVAILABLE", "sender agent is unavailable");
    }
    if (recipient.status !== "active" || !recipient.acceptsMessages) {
      throw new MessagingError("RECIPIENT_UNAVAILABLE", "recipient agent is unavailable");
    }
    if (recipient.agentId === sender.agentId) {
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
    if (input.idempotencyKey && Buffer.byteLength(input.idempotencyKey, "utf8") > 256) {
      throw new MessagingError("IDEMPOTENCY_KEY_TOO_LARGE", "idempotency key is too large");
    }
    const chain = input.callChain ?? [sender.agentId];
    if (chain.at(-1) !== sender.agentId) {
      throw new MessagingError(
        "INVALID_CALL_CHAIN",
        "call chain must end with the authenticated sender",
      );
    }
    if (chain.length > this.#options.config.maxCallChainLength) {
      throw new MessagingError("CALL_CHAIN_LIMIT", "call chain exceeds configured limit");
    }
    if (chain.length - 1 >= this.#options.config.maxHopCount) {
      throw new MessagingError("HOP_LIMIT", "request exceeds configured hop limit");
    }
  }

  #result(record: MessageRecord): AskAgentResult {
    if (
      record.status === "completed" &&
      record.replyBody !== null &&
      record.targetThreadId &&
      record.targetTurnId
    ) {
      return {
        status: "completed",
        messageId: record.messageId,
        conversationId: record.conversationId,
        fromAgent: record.recipientAgentId,
        reply: record.replyBody,
        targetThreadId: record.targetThreadId,
        targetTurnId: record.targetTurnId,
      };
    }
    if (["failed", "dead_letter"].includes(record.status)) {
      return {
        status: "failed",
        messageId: record.messageId,
        conversationId: record.conversationId,
        errorCode: record.errorCode ?? "DELIVERY_FAILED",
        error: record.errorMessage ?? "delivery failed",
      };
    }
    return {
      status: "pending",
      messageId: record.messageId,
      conversationId: record.conversationId,
    };
  }
}
