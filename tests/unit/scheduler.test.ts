import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerClient } from "../../src/app_server/client.js";
import { loadConfig } from "../../src/config/index.js";
import { createLogger } from "../../src/logging/logger.js";
import { DeliveryScheduler } from "../../src/messaging/scheduler.js";
import { BridgeDatabase } from "../../src/store/database.js";
import {
  AgentRepository,
  MessageRepository,
  RecipientLeaseRepository,
} from "../../src/store/repositories.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function setup(appServer: AppServerClient, overrides: Record<string, number> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-scheduler-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new BridgeDatabase(path.join(directory, "bridge.sqlite3"));
  cleanup.push(() => {
    store.close();
    return Promise.resolve();
  });
  const agents = new AgentRepository(store, {
    ownerMode: "bridge-managed",
    installationId: "test-installation",
    databaseId: "test-database",
    protocolVersion: "1",
  });
  agents.register({
    agentId: "sender",
    displayName: "Sender",
    threadId: "thread_s",
    workspace: "C:/s",
  });
  agents.register({
    agentId: "recipient",
    displayName: "Recipient",
    threadId: "thread_r",
    workspace: "C:/r",
  });
  const messages = new MessageRepository(store);
  const leases = new RecipientLeaseRepository(store);
  const base = loadConfig({}, directory);
  const config = {
    ...base.messaging,
    busyPollMs: 1,
    retryBaseMs: 1,
    retryMaximumMs: 2,
    retryJitterPercent: 0,
    turnTimeoutMs: 1_000,
    ...overrides,
  };
  const create = (messageId: string, body = messageId) =>
    messages.create({
      messageId,
      conversationId: `conv_${messageId}`,
      senderAgentId: "sender",
      recipientAgentId: "recipient",
      recipientGeneration: 1,
      kind: "request",
      body,
      expectsReply: true,
      hopCount: 0,
      callChain: ["sender"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  return { store, agents, messages, leases, config, create, appServer };
}

function completed(threadId: string, turnId: string, reply: string) {
  return {
    threadId,
    turnId,
    status: "completed",
    turn: { id: turnId, status: "completed" },
    agentMessages: [
      { id: `agent_${turnId}`, type: "agentMessage", text: reply, phase: "final_answer" },
    ],
    finalMessage: {
      id: `agent_${turnId}`,
      type: "agentMessage",
      text: reply,
      phase: "final_answer",
    },
  };
}

describe("DeliveryScheduler", () => {
  it("fails closed for an unbound recipient before any app-server call", async () => {
    let appServerCalls = 0;
    const fake = {
      resumeThread: () => {
        appServerCalls += 1;
        return Promise.resolve({ thread: { status: { type: "idle" } } });
      },
      readThread: () => {
        appServerCalls += 1;
        return Promise.resolve({ thread: { turns: [] } });
      },
      startTurn: () => {
        appServerCalls += 1;
        throw new Error("must not start");
      },
    } as unknown as AppServerClient;
    const context = await setup(fake);
    context.store.database
      .prepare(
        "UPDATE agents SET owner_mode = 'unverified', owner_installation_id = NULL, owner_database_id = NULL, owner_protocol_version = NULL WHERE agent_id = 'recipient'",
      )
      .run();
    const created = context.create("unsupported-owner");
    const result = await new DeliveryScheduler({ instanceId: "owner-check", ...context }).schedule(
      created.messageId,
    );
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "UNSUPPORTED_THREAD_OWNER",
    });
    expect(appServerCalls).toBe(0);
  });

  it("fails closed when resume returns a different thread identity", async () => {
    let starts = 0;
    const fake = {
      resumeThread: () =>
        Promise.resolve({ thread: { id: "thread_foreign", status: { type: "idle" } } }),
      startTurn: () => {
        starts += 1;
        throw new Error("must not start");
      },
    } as unknown as AppServerClient;
    const context = await setup(fake);
    const created = context.create("wrong-thread-owner");
    const result = await new DeliveryScheduler({ instanceId: "wrong-thread", ...context }).schedule(
      created.messageId,
    );
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "UNSUPPORTED_THREAD_OWNER",
    });
    expect(starts).toBe(0);
  });

  it("preserves per-recipient FIFO and excludes concurrent delivery", async () => {
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const fake = {
      resumeThread: (threadId: string) =>
        Promise.resolve({ thread: { id: threadId, status: { type: "idle" } } }),
      startTurn: (_threadId: string, _text: string, options: { clientUserMessageId: string }) => {
        order.push(options.clientUserMessageId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const turnId = `turn_${options.clientUserMessageId}`;
        return Promise.resolve({
          turnId,
          completion: new Promise((resolve) =>
            setTimeout(() => {
              active -= 1;
              resolve(completed("thread_r", turnId, options.clientUserMessageId));
            }, 10),
          ),
        });
      },
    } as unknown as AppServerClient;
    const context = await setup(fake);
    context.create("msg_1");
    await new Promise((resolve) => setTimeout(resolve, 2));
    context.create("msg_2");
    const logLines: string[] = [];
    const first = new DeliveryScheduler({
      instanceId: "one",
      ...context,
      logger: createLogger("info", (line) => logLines.push(line)),
    });
    const second = new DeliveryScheduler({ instanceId: "two", ...context });
    const results = await Promise.all([first.schedule("msg_1"), second.schedule("msg_2")]);
    expect(results.map((record) => record.status)).toEqual(["completed", "completed"]);
    expect(order).toEqual(["msg_1", "msg_2"]);
    expect(maximumActive).toBe(1);
    expect(logLines[0]).toContain('"event":"message.queued"');
    expect(logLines[1]).toContain('"event":"message.dispatched"');
    expect(logLines[2]).toContain('"event":"message.completed"');
    expect(logLines.every((line) => line.includes('"messageId":"msg_1"'))).toBe(true);
  });

  it("defers an externally active thread without steering or consuming attempts", async () => {
    let resumes = 0;
    let starts = 0;
    let now = Date.now();
    const fake = {
      resumeThread: (threadId: string) => {
        resumes += 1;
        return Promise.resolve({
          thread: { id: threadId, status: { type: resumes < 3 ? "active" : "idle" } },
        });
      },
      startTurn: () => {
        starts += 1;
        return Promise.resolve({
          turnId: "turn_busy",
          completion: Promise.resolve(completed("thread_r", "turn_busy", "done")),
        });
      },
    } as unknown as AppServerClient;
    const context = await setup(fake);
    context.create("msg_busy");
    const scheduler = new DeliveryScheduler({
      instanceId: "busy",
      ...context,
      now: () => now,
      sleep: (milliseconds) => {
        now += Math.max(1, milliseconds);
        return Promise.resolve();
      },
    });
    const result = await scheduler.schedule("msg_busy");
    expect(result.status).toBe("completed");
    expect(starts).toBe(1);
    expect(result.attemptCount).toBe(1);
  });

  it("reconciles an accepted turn by client message ID after a disconnect", async () => {
    let starts = 0;
    const fake = {
      resumeThread: (threadId: string) =>
        Promise.resolve({ thread: { id: threadId, status: { type: "idle" } } }),
      startTurn: () => {
        starts += 1;
        throw Object.assign(new Error("transport disconnected after acceptance"), {
          code: "TRANSPORT_CLOSED",
        });
      },
      readThread: (threadId: string) =>
        Promise.resolve({
          thread: {
            id: threadId,
            turns: [
              {
                id: "turn_recovered",
                status: "completed",
                items: [
                  { type: "userMessage", clientId: "msg_uncertain" },
                  { type: "agentMessage", text: "recovered reply" },
                ],
              },
            ],
          },
        }),
    } as unknown as AppServerClient;
    const context = await setup(fake);
    context.create("msg_uncertain");
    const result = await new DeliveryScheduler({ instanceId: "recover", ...context }).schedule(
      "msg_uncertain",
    );
    expect(result).toMatchObject({
      status: "completed",
      replyBody: "recovered reply",
      targetTurnId: "turn_recovered",
    });
    expect(starts).toBe(1);
  });

  it("bounds transient retries and records a terminal failure", async () => {
    let starts = 0;
    const fake = {
      resumeThread: (threadId: string) =>
        Promise.resolve({ thread: { id: threadId, status: { type: "idle" } } }),
      startTurn: () => {
        starts += 1;
        throw Object.assign(new Error("temporary disconnect"), { code: "TRANSPORT_CLOSED" });
      },
      readThread: (threadId: string) => Promise.resolve({ thread: { id: threadId, turns: [] } }),
    } as unknown as AppServerClient;
    const context = await setup(fake, { maxRetryAttempts: 2 });
    context.create("msg_retry");
    const result = await new DeliveryScheduler({ instanceId: "retry", ...context }).schedule(
      "msg_retry",
    );
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "TRANSPORT_CLOSED",
      attemptCount: 2,
    });
    expect(starts).toBe(2);
  });

  it("checks current generation before recovering an expired lease", async () => {
    let starts = 0;
    const fake = {
      resumeThread: (threadId: string) =>
        Promise.resolve({ thread: { id: threadId, status: { type: "idle" } } }),
      startTurn: () => {
        starts += 1;
        throw new Error("must not start");
      },
    } as unknown as AppServerClient;
    const context = await setup(fake);
    context.create("msg_stale");
    context.leases.acquire("thread_r", "dead-owner", 1, Date.now() - 10);
    context.agents.replace("recipient", "thread_r2", "C:/r2", 1);
    const result = await new DeliveryScheduler({ instanceId: "replacement", ...context }).schedule(
      "msg_stale",
    );
    expect(result).toMatchObject({ status: "failed", errorCode: "STALE_RECIPIENT" });
    expect(starts).toBe(0);
  });

  it("fails an expired message without starting a recipient turn", async () => {
    let starts = 0;
    const fake = {
      startTurn: () => {
        starts += 1;
        throw new Error("must not start");
      },
    } as unknown as AppServerClient;
    const context = await setup(fake);
    context.messages.create({
      messageId: "msg_expired",
      conversationId: "conv_expired",
      senderAgentId: "sender",
      recipientAgentId: "recipient",
      recipientGeneration: 1,
      kind: "request",
      body: "expired",
      expectsReply: true,
      hopCount: 0,
      callChain: ["sender"],
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    const result = await new DeliveryScheduler({ instanceId: "expired", ...context }).schedule(
      "msg_expired",
    );
    expect(result).toMatchObject({ status: "failed", errorCode: "MESSAGE_EXPIRED" });
    expect(starts).toBe(0);
  });

  it("bounds concurrent recipient turns within one MCP process", async () => {
    let active = 0;
    let maximumActive = 0;
    const fake = {
      resumeThread: (threadId: string) =>
        Promise.resolve({ thread: { id: threadId, status: { type: "idle" } } }),
      startTurn: (threadId: string, _text: string, options: { clientUserMessageId: string }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const turnId = `turn_${options.clientUserMessageId}`;
        return Promise.resolve({
          turnId,
          completion: new Promise((resolve) =>
            setTimeout(() => {
              active -= 1;
              resolve(completed(threadId, turnId, "done"));
            }, 10),
          ),
        });
      },
    } as unknown as AppServerClient;
    const context = await setup(fake, { maxConcurrentDeliveries: 1 });
    context.agents.register({
      agentId: "recipient-two",
      displayName: "Recipient Two",
      threadId: "thread_r2",
      workspace: "C:/r2",
    });
    context.create("msg_capacity_one");
    context.messages.create({
      messageId: "msg_capacity_two",
      conversationId: "conv_capacity_two",
      senderAgentId: "sender",
      recipientAgentId: "recipient-two",
      recipientGeneration: 1,
      kind: "request",
      body: "second",
      expectsReply: true,
      hopCount: 0,
      callChain: ["sender"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const scheduler = new DeliveryScheduler({ instanceId: "capacity", ...context });
    const results = await Promise.all([
      scheduler.schedule("msg_capacity_one"),
      scheduler.schedule("msg_capacity_two"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(maximumActive).toBe(1);
  });

  it.each(["failed", "interrupted"])(
    "persists a structured failure for a %s recipient turn",
    async (status) => {
      const fake = {
        resumeThread: (threadId: string) =>
          Promise.resolve({ thread: { id: threadId, status: { type: "idle" } } }),
        startTurn: () =>
          Promise.resolve({
            turnId: `turn_${status}`,
            completion: Promise.resolve({
              threadId: "thread_r",
              turnId: `turn_${status}`,
              status,
              turn: { id: `turn_${status}`, status },
              agentMessages: [],
              finalMessage: null,
            }),
          }),
      } as unknown as AppServerClient;
      const context = await setup(fake);
      context.create(`msg_${status}`);
      const result = await new DeliveryScheduler({ instanceId: status, ...context }).schedule(
        `msg_${status}`,
      );
      expect(result).toMatchObject({ status: "failed", errorCode: "TURN_NOT_COMPLETED" });
      expect(result.errorMessage).toContain(status);
    },
  );

  it("maps unrecoverable context saturation without retry or rebinding", async () => {
    let starts = 0;
    const fake = {
      resumeThread: (threadId: string) =>
        Promise.resolve({ thread: { id: threadId, status: { type: "idle" } } }),
      startTurn: () => {
        starts += 1;
        return Promise.resolve({
          turnId: "turn_saturated",
          completion: Promise.resolve({
            threadId: "thread_r",
            turnId: "turn_saturated",
            status: "failed",
            turn: {
              id: "turn_saturated",
              status: "failed",
              error: { message: "context length exceeded maximum token limit" },
            },
            agentMessages: [],
            finalMessage: null,
          }),
        });
      },
    } as unknown as AppServerClient;
    const context = await setup(fake, { maxRetryAttempts: 5 });
    context.create("msg_saturated");
    const result = await new DeliveryScheduler({ instanceId: "saturated", ...context }).schedule(
      "msg_saturated",
    );
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "RECIPIENT_CONTEXT_EXHAUSTED",
      targetThreadId: "thread_r",
      targetTurnId: "turn_saturated",
      attemptCount: 1,
    });
    expect(starts).toBe(1);
    expect(context.agents.get("recipient")).toMatchObject({
      activeThreadId: "thread_r",
      generation: 1,
    });
  });

  it("dead-letters asynchronous work after bounded transient retries", async () => {
    const fake = {
      resumeThread: (threadId: string) =>
        Promise.resolve({ thread: { id: threadId, status: { type: "idle" } } }),
      startTurn: () => {
        throw Object.assign(new Error("temporary disconnect"), { code: "TRANSPORT_CLOSED" });
      },
      readThread: (threadId: string) => Promise.resolve({ thread: { id: threadId, turns: [] } }),
    } as unknown as AppServerClient;
    const context = await setup(fake, { maxRetryAttempts: 2 });
    context.messages.create({
      messageId: "msg_async_dead",
      conversationId: "conv_async_dead",
      senderAgentId: "sender",
      recipientAgentId: "recipient",
      recipientGeneration: 1,
      kind: "notice",
      body: "eventually dead-letter",
      expectsReply: false,
      hopCount: 0,
      callChain: ["sender"],
    });
    const result = await new DeliveryScheduler({ instanceId: "async-dead", ...context }).schedule(
      "msg_async_dead",
    );
    expect(result).toMatchObject({
      status: "dead_letter",
      errorCode: "TRANSPORT_CLOSED",
      attemptCount: 2,
    });
  });
});
