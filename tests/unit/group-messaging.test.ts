import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerClient } from "../../src/app_server/client.js";
import { loadConfig } from "../../src/config/index.js";
import { AsyncMessagingService } from "../../src/messaging/async_service.js";
import { GroupMessagingService } from "../../src/messaging/group_service.js";
import { DeliveryScheduler } from "../../src/messaging/scheduler.js";
import { BridgeDatabase } from "../../src/store/database.js";
import { GroupRepository } from "../../src/store/groups.js";
import {
  AgentRepository,
  MessageRepository,
  RecipientLeaseRepository,
} from "../../src/store/repositories.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function setup(maxGroupFanout = 20) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-groups-"));
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
  for (const id of ["owner", "member-a", "member-b", "outsider"]) {
    agents.register({
      agentId: id,
      displayName: id,
      threadId: `thread_${id}`,
      workspace: `C:/${id}`,
    });
  }
  const starts = new Map<string, number>();
  const fake = {
    resumeThread: (threadId: string) =>
      Promise.resolve({ thread: { id: threadId, status: { type: "idle" } } }),
    startTurn: (threadId: string) => {
      const count = (starts.get(threadId) ?? 0) + 1;
      starts.set(threadId, count);
      if (threadId === "thread_member-b" && count === 1) {
        throw Object.assign(new Error("temporary disconnect"), { code: "TRANSPORT_CLOSED" });
      }
      const turnId = `turn_${threadId}_${count}`;
      return Promise.resolve({
        turnId,
        completion: Promise.resolve({
          threadId,
          turnId,
          status: "completed",
          turn: { id: turnId, status: "completed" },
          agentMessages: [],
          finalMessage: null,
        }),
      });
    },
    readThread: (threadId: string) => Promise.resolve({ thread: { id: threadId, turns: [] } }),
  } as unknown as AppServerClient;
  const base = loadConfig({}, directory);
  const config = {
    ...base.messaging,
    maxRetryAttempts: 1,
    retryBaseMs: 1,
    retryMaximumMs: 1,
    retryJitterPercent: 0,
    busyPollMs: 1,
    maxGroupFanout,
  };
  const messages = new MessageRepository(store);
  const scheduler = new DeliveryScheduler({
    instanceId: "groups-test",
    config: { ...config, turnTimeoutMs: 1_000 },
    appServer: fake,
    agents,
    messages,
    leases: new RecipientLeaseRepository(store),
  });
  const groups = new GroupRepository(store);
  groups.create("reviewers", "Reviewers", "owner");
  groups.addMember("reviewers", "member-a");
  groups.addMember("reviewers", "member-b");
  const service = (senderAgentId: string, authorize?: (from: string, to: string) => boolean) =>
    new GroupMessagingService({
      senderAgentId,
      config,
      agents,
      groups,
      scheduler,
      ...(authorize ? { authorize } : {}),
    });
  const asyncService = (senderAgentId: string) =>
    new AsyncMessagingService({ senderAgentId, config, agents, messages, scheduler });
  return { store, agents, messages, scheduler, groups, service, asyncService, starts };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  if (!predicate()) throw new Error("condition did not become true");
}

describe("group messaging", () => {
  it("snapshots membership, isolates partial failure, and retries only the failed recipient", async () => {
    const context = await setup();
    const owner = context.service("owner");
    const sent = owner.send({
      groupId: "reviewers",
      message: "review independently",
      idempotencyKey: "group-once",
    });
    const duplicate = owner.send({
      groupId: "reviewers",
      message: "review independently",
      idempotencyKey: "group-once",
    });
    expect(duplicate.groupMessageId).toBe(sent.groupMessageId);
    context.groups.removeMember("reviewers", "member-b");
    await waitFor(() => {
      const statuses = owner.status(sent.groupMessageId).deliveries.map((item) => item.status);
      return statuses.includes("delivered") && statuses.includes("dead_letter");
    });
    const partial = owner.status(sent.groupMessageId);
    expect(partial.deliveries).toHaveLength(2);
    expect(context.groups.getMessage(sent.groupMessageId).membershipSnapshot).toEqual([
      "member-a",
      "member-b",
      "owner",
    ]);
    const retried = owner.retry(sent.groupMessageId);
    await waitFor(() => owner.status(sent.groupMessageId).summary.delivered === 2);
    expect(retried.deliveries.find((item) => item.recipient === "member-a")?.status).toBe(
      "delivered",
    );
    expect(context.starts.get("thread_member-a")).toBe(1);
    expect(context.starts.get("thread_member-b")).toBe(2);
  });

  it("enforces visibility, membership, ACL, and fan-out limits", async () => {
    const context = await setup(1);
    expect(context.service("outsider").listGroups()).toEqual([]);
    expect(() =>
      context.service("outsider").send({ groupId: "reviewers", message: "intrude" }),
    ).toThrow(/not a group member/);
    expect(() =>
      context.service("owner").send({ groupId: "reviewers", message: "too many" }),
    ).toThrow(/fan-out/);
    const allowedSize = await setup(20);
    expect(() =>
      allowedSize
        .service("owner", (_from, to) => to !== "member-b")
        .send({ groupId: "reviewers", message: "ACL blocks one" }),
    ).toThrow(/forbidden/);
    expect(
      allowedSize.store.database.prepare("SELECT count(*) AS count FROM group_messages").get(),
    ).toEqual({ count: 0 });
  });

  it("re-checks current sender, recipient, and ACL state before selective retry", async () => {
    const context = await setup();
    const owner = context.service("owner", (_from, to) => to !== "member-b");
    const unrestricted = context.service("owner");
    const sent = unrestricted.send({ groupId: "reviewers", message: "retry safely" });
    await waitFor(() => unrestricted.status(sent.groupMessageId).summary.dead_letter === 1);
    expect(() => owner.retry(sent.groupMessageId, ["member-b"])).toThrow(/forbidden/);
    context.agents.setStatus("member-b", "paused");
    expect(() => unrestricted.retry(sent.groupMessageId, ["member-b"])).toThrow(/unavailable/);
    context.agents.setStatus("member-b", "active");
    context.agents.setStatus("owner", "paused");
    expect(() => unrestricted.retry(sent.groupMessageId, ["member-b"])).toThrow(/sender/);
  });

  it("gathers only explicit replies and names the synthesizing agent", async () => {
    const context = await setup();
    const owner = context.service("owner");
    const sent = owner.send({ groupId: "reviewers", message: "send explicit replies" });
    await waitFor(() => {
      const status = owner.status(sent.groupMessageId);
      return status.deliveries.every((delivery) =>
        new Set(["delivered", "dead_letter"]).has(delivery.status),
      );
    });
    const memberDelivery = owner
      .status(sent.groupMessageId)
      .deliveries.find((delivery) => delivery.recipient === "member-a");
    if (!memberDelivery) throw new Error("member delivery missing");
    const reply = context
      .asyncService("member-a")
      .reply({ messageId: memberDelivery.messageId, message: "explicit visible result" });
    await waitFor(
      () => context.asyncService("member-a").status(reply.messageId).status === "delivered",
    );
    expect(owner.gather(sent.groupMessageId)).toEqual({
      groupMessageId: sent.groupMessageId,
      synthesizingAgent: "owner",
      replies: [
        {
          fromAgent: "member-a",
          messageId: reply.messageId,
          reply: "explicit visible result",
        },
      ],
    });
    expect(() => context.service("member-a").gather(sent.groupMessageId)).toThrow(
      /original sender/,
    );
  });
});
