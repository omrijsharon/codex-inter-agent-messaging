import { setTimeout as delay } from "node:timers/promises";
import type { AppServerClient } from "../app_server/client.js";
import { isJsonObject, type JsonObject } from "../app_server/protocol.js";
import { extractAuthoritativeFinalReply } from "../app_server/turn_collector.js";
import type { BridgeConfig } from "../config/index.js";
import { LOG_EVENTS, redactSensitiveText, type Logger } from "../logging/logger.js";
import type { AgentRecord, MessageRecord } from "../store/models.js";
import type {
  AgentRepository,
  MessageRepository,
  RecipientLeaseRepository,
} from "../store/repositories.js";
import { buildAsyncPeerEnvelope, buildPeerEnvelope } from "./envelope.js";

export interface DeliverySchedulerOptions {
  readonly instanceId: string;
  readonly config: BridgeConfig["messaging"] & { turnTimeoutMs: number };
  readonly appServer: AppServerClient;
  readonly agents: AgentRepository;
  readonly messages: MessageRepository;
  readonly leases: RecipientLeaseRepository;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

type Reconciliation = "not_found" | "in_progress" | "terminal";

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string"
    ? code
    : typeof code === "number"
      ? `APP_SERVER_${code}`
      : "DELIVERY_FAILED";
}

function transient(error: unknown): boolean {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : "";
  return (
    new Set([
      "RECIPIENT_BUSY",
      "RECIPIENT_IN_PROGRESS",
      "TRANSPORT_CLOSED",
      "REQUEST_TIMEOUT",
      "APP_SERVER_TIMEOUT",
      "APP_SERVER_EXIT",
      "NOT_CONNECTED",
    ]).has(code) || /\b(active|busy|disconnect|temporar|timeout)\b/i.test(message)
  );
}

function contextExhausted(value: unknown): boolean {
  try {
    return /(?:context|token).{0,40}(?:exhaust|limit|length|maximum|too large)/i.test(
      JSON.stringify(value),
    );
  } catch {
    return false;
  }
}

export class DeliveryScheduler {
  readonly #options: Required<Pick<DeliverySchedulerOptions, "now" | "random" | "sleep">> &
    DeliverySchedulerOptions;
  readonly #running = new Map<string, Promise<MessageRecord>>();
  readonly #permitWaiters: Array<() => void> = [];
  #activeDeliveries = 0;

  constructor(options: DeliverySchedulerOptions) {
    this.#options = {
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      sleep: options.sleep ?? ((milliseconds) => delay(milliseconds)),
      ...options,
    };
  }

  schedule(messageId: string): Promise<MessageRecord> {
    const existing = this.#running.get(messageId);
    if (existing) return existing;
    const queued = this.#options.messages.get(messageId);
    if (!new Set(["completed", "failed", "dead_letter"]).has(queued.status)) {
      this.#options.logger?.info(LOG_EVENTS.messageQueued, this.#correlation(queued));
    }
    const running = this.#run(messageId).finally(() => this.#running.delete(messageId));
    this.#running.set(messageId, running);
    return running;
  }

  recoverUnfinished(): Promise<MessageRecord[]> {
    return Promise.all(
      this.#options.messages.unfinished().map((record) => this.schedule(record.messageId)),
    );
  }

  async #run(messageId: string): Promise<MessageRecord> {
    while (true) {
      let record = this.#options.messages.get(messageId);
      if (new Set(["completed", "failed", "dead_letter"]).has(record.status)) return record;
      if (record.expiresAt && Date.parse(record.expiresAt) <= this.#options.now()) {
        return this.#failTerminal(record, messageId, "MESSAGE_EXPIRED", "message TTL expired");
      }
      const recipient = this.#options.agents.get(record.recipientAgentId);
      if (
        recipient.generation !== record.recipientGeneration ||
        recipient.status !== "active" ||
        !recipient.acceptsMessages
      ) {
        return this.#failTerminal(
          record,
          messageId,
          "STALE_RECIPIENT",
          "recipient generation is no longer active",
        );
      }
      if (!this.#options.agents.isOwnedByCurrentHost(recipient)) {
        return this.#failTerminal(
          record,
          messageId,
          "UNSUPPORTED_THREAD_OWNER",
          "recipient is not bound to this bridge-managed app-server installation",
        );
      }
      const head = this.#options.messages.queueHead(recipient.agentId, recipient.generation);
      if (head?.messageId !== messageId) {
        await this.#options.sleep(this.#options.config.busyPollMs);
        continue;
      }
      if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > this.#options.now()) {
        await this.#options.sleep(
          Math.min(
            Date.parse(record.nextAttemptAt) - this.#options.now(),
            this.#options.config.retryMaximumMs,
          ),
        );
        continue;
      }

      const leaseToken = this.#options.leases.acquire(
        recipient.activeThreadId,
        this.#options.instanceId,
        this.#options.config.turnTimeoutMs + this.#options.config.retryMaximumMs,
        this.#options.now(),
      );
      if (!leaseToken) {
        await this.#options.sleep(this.#options.config.busyPollMs);
        continue;
      }

      let attemptId: string | null = null;
      let permitHeld = false;
      try {
        record = this.#options.messages.get(messageId);
        if (record.attemptCount > 0 || record.status !== "queued") {
          const reconciled = await this.#reconcile(record, recipient);
          if (reconciled === "terminal") return this.#options.messages.get(messageId);
          if (reconciled === "in_progress") {
            throw Object.assign(new Error("accepted recipient turn is still in progress"), {
              code: "RECIPIENT_IN_PROGRESS",
            });
          }
          record = this.#options.messages.recoverToQueued(messageId);
        }

        const resumed = await this.#options.appServer.resumeThread(recipient.activeThreadId);
        const thread = isJsonObject(resumed.thread) ? resumed.thread : null;
        if (thread?.id !== recipient.activeThreadId) {
          throw Object.assign(
            new Error("recipient is not visible through the authoritative app-server owner"),
            { code: "UNSUPPORTED_THREAD_OWNER" },
          );
        }
        const liveStatus = isJsonObject(thread?.status) ? thread.status.type : null;
        if (liveStatus !== "idle") {
          throw Object.assign(new Error("recipient has an active external turn"), {
            code: "RECIPIENT_BUSY",
          });
        }
        await this.#acquireDeliveryPermit();
        permitHeld = true;
        if (
          !this.#options.leases.renew(
            recipient.activeThreadId,
            leaseToken,
            this.#options.config.turnTimeoutMs + this.#options.config.retryMaximumMs,
            this.#options.now(),
          )
        ) {
          throw Object.assign(new Error("recipient lease expired while waiting for capacity"), {
            code: "RECIPIENT_BUSY",
          });
        }
        this.#options.messages.transition(messageId, "dispatching", { next_attempt_at: null });
        attemptId = this.#options.messages.startAttempt(messageId);
        this.#options.logger?.info(LOG_EVENTS.messageDispatched, {
          ...this.#correlation(record),
          attemptCount: record.attemptCount + 1,
        });
        const envelopeInput = {
          messageId,
          conversationId: record.conversationId,
          ...(record.parentMessageId ? { parentMessageId: record.parentMessageId } : {}),
          senderAgentId: record.senderAgentId,
          recipientAgentId: record.recipientAgentId,
          hopCount: record.hopCount,
          callChain: record.callChain,
          body: record.body,
          createdAt: record.createdAt,
          ...(record.groupId ? { groupId: record.groupId } : {}),
          ...(record.groupMessageId ? { groupMessageId: record.groupMessageId } : {}),
        };
        const envelope = record.expectsReply
          ? buildPeerEnvelope(envelopeInput)
          : buildAsyncPeerEnvelope(envelopeInput);
        const started = await this.#options.appServer.startTurn(
          recipient.activeThreadId,
          envelope,
          {
            clientUserMessageId: messageId,
            timeoutMs: this.#options.config.turnTimeoutMs,
          },
        );
        this.#options.messages.transition(messageId, "running", {
          delivered_at: new Date(this.#options.now()).toISOString(),
          target_thread_id: recipient.activeThreadId,
          target_turn_id: started.turnId,
        });
        const collected = await started.completion;
        if (collected.status !== "completed" && contextExhausted(collected.turn)) {
          throw Object.assign(new Error("recipient context is exhausted"), {
            code: "RECIPIENT_CONTEXT_EXHAUSTED",
          });
        }
        const reply = record.expectsReply ? extractAuthoritativeFinalReply(collected) : null;
        this.#options.messages.finishAttempt(attemptId, "completed", started.turnId);
        this.#options.messages.transition(messageId, "completed", {
          completed_at: new Date(this.#options.now()).toISOString(),
          ...(reply !== null ? { reply_body: reply } : {}),
        });
        this.#options.messages.closeDependency(messageId);
        const completed = this.#options.messages.get(messageId);
        this.#options.logger?.info(LOG_EVENTS.messageCompleted, {
          ...this.#correlation(completed),
          targetThreadId: completed.targetThreadId,
          targetTurnId: completed.targetTurnId,
          attemptCount: completed.attemptCount,
        });
        return completed;
      } catch (error) {
        if (attemptId) {
          try {
            this.#options.messages.finishAttempt(attemptId, "failed", undefined, errorCode(error));
          } catch {
            // An attempt recovered elsewhere may already be terminal.
          }
        }
        record = this.#options.messages.get(messageId);
        if (!transient(error) || record.attemptCount >= this.#options.config.maxRetryAttempts) {
          const safeMessage =
            error instanceof Error
              ? redactSensitiveText(error.message) === "[REDACTED]"
                ? "delivery failed; sensitive details redacted"
                : error.message
              : "delivery failed";
          if (
            !record.expectsReply &&
            transient(error) &&
            record.attemptCount >= this.#options.config.maxRetryAttempts
          ) {
            const failed = this.#options.messages.deadLetter(
              messageId,
              errorCode(error),
              safeMessage,
            );
            this.#logFailed(failed);
            return failed;
          }
          return this.#failTerminal(record, messageId, errorCode(error), safeMessage);
        }
        const backoff = this.#backoff(record.attemptCount);
        this.#options.messages.scheduleRetry(
          messageId,
          new Date(this.#options.now() + backoff).toISOString(),
        );
      } finally {
        if (permitHeld) this.#releaseDeliveryPermit();
        this.#options.leases.release(recipient.activeThreadId, leaseToken);
      }
    }
  }

  #backoff(attempt: number): number {
    const base = Math.min(
      this.#options.config.retryBaseMs * 2 ** Math.max(0, attempt - 1),
      this.#options.config.retryMaximumMs,
    );
    const spread = base * (this.#options.config.retryJitterPercent / 100);
    return Math.max(0, Math.round(base - spread + this.#options.random() * spread * 2));
  }

  #correlation(record: MessageRecord): Record<string, unknown> {
    return {
      messageId: record.messageId,
      conversationId: record.conversationId,
      senderAgentId: record.senderAgentId,
      recipientAgentId: record.recipientAgentId,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      ...(record.groupMessageId ? { groupMessageId: record.groupMessageId } : {}),
    };
  }

  #logFailed(record: MessageRecord): void {
    this.#options.logger?.warn(LOG_EVENTS.messageFailed, {
      ...this.#correlation(record),
      status: record.status,
      errorCode: record.errorCode,
      attemptCount: record.attemptCount,
    });
  }

  #failTerminal(
    record: MessageRecord,
    messageId: string,
    code: string,
    message: string,
  ): MessageRecord {
    const failed = this.#options.messages.failTerminal(messageId, code, message);
    this.#logFailed({ ...record, ...failed });
    return failed;
  }

  async #acquireDeliveryPermit(): Promise<void> {
    if (this.#activeDeliveries < this.#options.config.maxConcurrentDeliveries) {
      this.#activeDeliveries += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#permitWaiters.push(resolve));
    this.#activeDeliveries += 1;
  }

  #releaseDeliveryPermit(): void {
    this.#activeDeliveries -= 1;
    this.#permitWaiters.shift()?.();
  }

  async #reconcile(record: MessageRecord, recipient: AgentRecord): Promise<Reconciliation> {
    const response = await this.#options.appServer.readThread(recipient.activeThreadId, true);
    const thread = isJsonObject(response.thread) ? response.thread : null;
    if (thread?.id !== recipient.activeThreadId) {
      throw Object.assign(
        new Error("recipient is not readable through the authoritative app-server owner"),
        { code: "UNSUPPORTED_THREAD_OWNER" },
      );
    }
    if (!Array.isArray(thread.turns)) return "not_found";
    for (const value of thread.turns) {
      if (!isJsonObject(value) || !Array.isArray(value.items)) continue;
      const items = value.items as unknown[];
      const matched = items.some(
        (item) =>
          isJsonObject(item) && item.type === "userMessage" && item.clientId === record.messageId,
      );
      if (!matched) continue;
      const turnId = typeof value.id === "string" ? value.id : record.targetTurnId;
      const status = typeof value.status === "string" ? value.status : "unknown";
      if (status === "inProgress") return "in_progress";
      if (status !== "completed" || !turnId) {
        this.#options.messages.failTerminal(
          record.messageId,
          contextExhausted(value) ? "RECIPIENT_CONTEXT_EXHAUSTED" : "RECIPIENT_TURN_FAILED",
          contextExhausted(value)
            ? "recipient context is exhausted"
            : `reconciled recipient turn ended with ${status}`,
        );
        return "terminal";
      }
      if (!record.expectsReply) {
        this.#options.messages.completeRecovered(
          record.messageId,
          recipient.activeThreadId,
          turnId,
          null,
        );
        return "terminal";
      }
      const final = [...items]
        .reverse()
        .find((item): item is JsonObject => isJsonObject(item) && item.type === "agentMessage");
      if (!final || typeof final.text !== "string") return "in_progress";
      this.#options.messages.completeRecovered(
        record.messageId,
        recipient.activeThreadId,
        turnId,
        final.text,
      );
      return "terminal";
    }
    return "not_found";
  }
}
