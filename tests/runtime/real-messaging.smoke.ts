import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureHostRunning, stopManagedHost } from "../../src/app_server/bootstrap.js";
import { AppServerClient } from "../../src/app_server/client.js";
import { loadConfig } from "../../src/config/index.js";
import { MessagingService } from "../../src/messaging/service.js";
import { BridgeDatabase } from "../../src/store/database.js";
import {
  AgentRepository,
  MessageRepository,
  RecipientLeaseRepository,
} from "../../src/store/repositories.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-real-m8-"));
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
  const service = new MessagingService({
    senderAgentId: "inter-agent",
    instanceId: "runtime_smoke",
    config: { ...config.messaging, turnTimeoutMs: config.appServer.turnTimeoutMs },
    appServer: client,
    agents,
    messages,
    leases: new RecipientLeaseRepository(store),
  });
  const result = await service.ask({
    recipient: "prepare-inter-agent-thread",
    message:
      "In one short clause, state the purpose your user assigned to this thread before this message. On the final line, write exactly MVP_ACCEPTANCE_OK. Do not call tools.",
    conversationId: "production-m8-runtime-smoke",
    idempotencyKey: "production-m8-named-pair",
    waitMs: 180_000,
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("runtime message did not complete");
  assert.match(result.reply, /(?:^|\n)MVP_ACCEPTANCE_OK$/);
  assert.equal(messages.get(result.messageId).status, "completed");
  const duplicate = await service.ask({
    recipient: "prepare-inter-agent-thread",
    message:
      "In one short clause, state the purpose your user assigned to this thread before this message. On the final line, write exactly MVP_ACCEPTANCE_OK. Do not call tools.",
    idempotencyKey: "production-m8-named-pair",
  });
  assert.equal(duplicate.messageId, result.messageId);
  assert.equal(messages.get(result.messageId).attemptCount, 1);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client?.close();
  store?.close();
  await stopManagedHost(config, false).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
