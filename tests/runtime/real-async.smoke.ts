import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureHostRunning, stopManagedHost } from "../../src/app_server/bootstrap.js";
import { AppServerClient } from "../../src/app_server/client.js";
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

const directory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-real-async-"));
const config = loadConfig({ BRIDGE_DATA_DIRECTORY: directory }, os.homedir());
let client: AppServerClient | null = null;
let store: BridgeDatabase | null = null;
try {
  const connection = await ensureHostRunning(config);
  client = new AppServerClient({
    url: connection.url,
    authToken: connection.authToken,
    reconnectLimit: 0,
  });
  await client.connect();
  store = new BridgeDatabase(path.join(directory, "bridge.sqlite3"));
  const agents = new AgentRepository(store, {
    ownerMode: connection.descriptor.ownerMode,
    installationId: connection.descriptor.installationId,
    databaseId: connection.descriptor.databaseId,
    protocolVersion: connection.descriptor.protocolVersion,
  });
  agents.register({
    agentId: "inter-agent",
    displayName: "inter-agent",
    threadId: "019f5f8d-f4f6-79c1-8ce3-4d767b906934",
    workspace: process.cwd(),
  });
  agents.register({
    agentId: "prepare-inter-agent-thread",
    displayName: "Prepare inter-agent thread",
    threadId: "019f6082-fd66-7da2-aa9f-b6461c2c486d",
    workspace: directory,
  });
  const messages = new MessageRepository(store);
  const scheduler = new DeliveryScheduler({
    instanceId: "runtime_async_smoke",
    config: { ...config.messaging, turnTimeoutMs: config.appServer.turnTimeoutMs },
    appServer: client,
    agents,
    messages,
    leases: new RecipientLeaseRepository(store),
  });
  const sender = new AsyncMessagingService({
    senderAgentId: "inter-agent",
    config: config.messaging,
    agents,
    messages,
    scheduler,
  });
  const recipient = new AsyncMessagingService({
    senderAgentId: "prepare-inter-agent-thread",
    config: config.messaging,
    agents,
    messages,
    scheduler,
  });
  const accepted = sender.send({
    recipient: "prepare-inter-agent-thread",
    message:
      "This is the v0.2 asynchronous delivery smoke. Reply exactly ASYNC_RECIPIENT_OUTPUT_DISCARDED and do not call tools.",
    kind: "notice",
    conversationId: "production-v0.2-async-smoke",
    idempotencyKey: "production-v0.2-async-smoke",
  });
  assert.equal(accepted.status, "queued");
  const deadline = Date.now() + 180_000;
  while (sender.status(accepted.messageId).status !== "delivered" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const status = sender.status(accepted.messageId);
  assert.equal(status.status, "delivered");
  const stored = messages.get(accepted.messageId);
  assert.equal(stored.replyBody, null);
  assert.equal(stored.attemptCount, 1);
  const inbox = recipient.readInbox({ markRead: false });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0]?.messageId, accepted.messageId);
  const groups = new GroupRepository(store);
  groups.create("runtime-reviewers", "Runtime Reviewers", "inter-agent");
  groups.addMember("runtime-reviewers", "prepare-inter-agent-thread");
  const groupService = new GroupMessagingService({
    senderAgentId: "inter-agent",
    config: config.messaging,
    agents,
    groups,
    scheduler,
  });
  const groupAccepted = groupService.send({
    groupId: "runtime-reviewers",
    message: "This is the v0.3 group fan-out smoke. Reply exactly GROUP_OUTPUT_DISCARDED.",
    idempotencyKey: "production-v0.3-group-smoke",
  });
  const groupDeadline = Date.now() + 180_000;
  while (
    groupService.status(groupAccepted.groupMessageId).summary.delivered !== 1 &&
    Date.now() < groupDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const groupStatus = groupService.status(groupAccepted.groupMessageId);
  assert.equal(groupStatus.summary.delivered, 1);
  assert.equal(groupStatus.deliveries.length, 1);
  const groupDelivery = messages.get(groupStatus.deliveries[0]?.messageId ?? "");
  assert.equal(groupDelivery.groupId, "runtime-reviewers");
  assert.equal(groupDelivery.groupMessageId, groupAccepted.groupMessageId);
  assert.equal(groupDelivery.replyBody, null);
  process.stdout.write(
    `${JSON.stringify({ accepted, status, inbox: inbox.messages[0], groupAccepted, groupStatus }, null, 2)}\n`,
  );
} finally {
  await client?.close();
  store?.close();
  await stopManagedHost(config, false).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
