import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerClient } from "../../src/app_server/client.js";
import { loadConfig } from "../../src/config/index.js";
import { AsyncMessagingService } from "../../src/messaging/async_service.js";
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

async function setup(resumeStatus: () => string = () => "idle", ttlMs = 60_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-async-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new BridgeDatabase(path.join(directory, "bridge.sqlite3"));
  cleanup.push(() => {
    store.close();
    return Promise.resolve();
  });
  const agents = new AgentRepository(store);
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
  const envelopes: string[] = [];
  let starts = 0;
  const fake = {
    resumeThread: (threadId: string) =>
      Promise.resolve({ thread: { id: threadId, status: { type: resumeStatus() } } }),
    startTurn: (threadId: string, text: string) => {
      starts += 1;
      envelopes.push(text);
      const turnId = `turn_${starts}`;
      return Promise.resolve({
        turnId,
        completion: Promise.resolve({
          threadId,
          turnId,
          status: "completed",
          turn: { id: turnId, status: "completed" },
          agentMessages: [
            {
              id: `agent_${starts}`,
              type: "agentMessage",
              text: "AUTOMATIC OUTPUT MUST NOT BECOME A NETWORK REPLY",
              phase: "final_answer",
            },
          ],
          finalMessage: {
            id: `agent_${starts}`,
            type: "agentMessage",
            text: "AUTOMATIC OUTPUT MUST NOT BECOME A NETWORK REPLY",
            phase: "final_answer",
          },
        }),
      });
    },
    readThread: () => Promise.resolve({ thread: { turns: [] } }),
  } as unknown as AppServerClient;
  const base = loadConfig({}, directory);
  const config = {
    ...base.messaging,
    busyPollMs: 1,
    retryBaseMs: 1,
    retryMaximumMs: 2,
    retryJitterPercent: 0,
    messageTtlMs: ttlMs,
  };
  const messages = new MessageRepository(store);
  const scheduler = new DeliveryScheduler({
    instanceId: "async-test",
    config: { ...config, turnTimeoutMs: 1_000 },
    appServer: fake,
    agents,
    messages,
    leases: new RecipientLeaseRepository(store),
  });
  const service = (senderAgentId: string) =>
    new AsyncMessagingService({ senderAgentId, config, agents, messages, scheduler });
  return { store, agents, messages, scheduler, service, envelopes, starts: () => starts };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error("condition did not become true");
}

describe("asynchronous messaging", () => {
  it("delivers, reads, acknowledges, and explicitly replies without automatic ping-pong", async () => {
    const context = await setup();
    const sender = context.service("sender");
    const recipient = context.service("recipient");
    const accepted = sender.send({
      recipient: "recipient",
      message: "asynchronous work",
      kind: "request",
      idempotencyKey: "async-once",
    });
    expect(accepted.status).toBe("queued");
    const duplicate = sender.send({
      recipient: "recipient",
      message: "asynchronous work",
      kind: "request",
      idempotencyKey: "async-once",
    });
    expect(duplicate.messageId).toBe(accepted.messageId);
    await waitFor(() => sender.status(accepted.messageId).status === "delivered");

    const stored = context.messages.get(accepted.messageId);
    expect(stored).toMatchObject({ status: "completed", expectsReply: false, replyBody: null });
    expect(context.envelopes[0]).toContain("ASYNC_INTER_AGENT_MESSAGE_V1");
    expect(context.envelopes[0]).toContain("Assistant output is not forwarded automatically");
    expect(context.starts()).toBe(1);

    const unread = recipient.readInbox({ markRead: false });
    expect(unread.messages).toMatchObject([
      { messageId: accepted.messageId, read: false, acknowledged: false, kind: "request" },
    ]);
    expect(recipient.acknowledge(accepted.messageId)).toMatchObject({
      read: true,
      acknowledged: true,
    });

    const reply = recipient.reply({ messageId: accepted.messageId, message: "explicit reply" });
    expect(reply.conversationId).toBe(accepted.conversationId);
    await waitFor(() => recipient.status(reply.messageId).status === "delivered");
    expect(sender.readInbox({}).messages).toMatchObject([
      {
        messageId: reply.messageId,
        parentMessageId: accepted.messageId,
        kind: "reply",
        message: "explicit reply",
      },
    ]);
    const count = context.store.database.prepare("SELECT count(*) AS count FROM messages").get();
    expect(count).toEqual({ count: 2 });
  });

  it("queues while a recipient is busy and starts only after it becomes idle", async () => {
    let resumes = 0;
    const context = await setup(() => (++resumes < 3 ? "active" : "idle"));
    const sender = context.service("sender");
    const accepted = sender.send({ recipient: "recipient", message: "wait for idle" });
    expect(accepted.status).toBe("queued");
    await waitFor(() => sender.status(accepted.messageId).status === "delivered");
    expect(resumes).toBeGreaterThanOrEqual(3);
    expect(context.starts()).toBe(1);
  });

  it("expires bounded queued work without starting a turn", async () => {
    const context = await setup(() => "active", 5);
    const sender = context.service("sender");
    const accepted = sender.send({ recipient: "recipient", message: "expire" });
    await waitFor(() => sender.status(accepted.messageId).status === "expired");
    expect(context.starts()).toBe(0);
  });

  it("recovers an unfinished asynchronous message after process restart", async () => {
    const context = await setup();
    context.messages.create({
      messageId: "msg_async_restart",
      conversationId: "conv_async_restart",
      senderAgentId: "sender",
      recipientAgentId: "recipient",
      recipientGeneration: 1,
      kind: "notice",
      body: "recover after restart",
      expectsReply: false,
      hopCount: 0,
      callChain: ["sender"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await context.scheduler.schedule("msg_async_restart");
    expect(context.messages.get("msg_async_restart")).toMatchObject({
      status: "completed",
      replyBody: null,
    });
  });
});
