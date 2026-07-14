import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureHostRunning,
  getHostStatus,
  stopManagedHost,
} from "../../src/app_server/bootstrap.js";
import { AppServerClient } from "../../src/app_server/client.js";
import { resolveRuntimeIdentity } from "../../src/app_server/identity.js";
import { loadConfig } from "../../src/config/index.js";
import { MessagingService } from "../../src/messaging/service.js";
import { BridgeDatabase } from "../../src/store/database.js";
import {
  AgentRepository,
  MessageRepository,
  RecipientLeaseRepository,
} from "../../src/store/repositories.js";
import { BRIDGE_OWNER_MODE, BRIDGE_OWNER_PROTOCOL_VERSION } from "../../src/version.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "codex-bootstrap-stability-"));
const config = loadConfig({ BRIDGE_DATA_DIRECTORY: directory, BRIDGE_LOG_LEVEL: "error" });
const identity = await resolveRuntimeIdentity(config);
const binding = {
  ownerMode: BRIDGE_OWNER_MODE,
  installationId: identity.installationId,
  databaseId: identity.databaseId,
  protocolVersion: BRIDGE_OWNER_PROTOCOL_VERSION,
};
const store = new BridgeDatabase(config.databasePath);
new AgentRepository(store, binding).register({
  agentId: "stability-sender",
  displayName: "Stability Sender",
  threadId: "00000000-0000-4000-8000-000000000010",
  workspace: process.cwd(),
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(await predicate())) throw new Error("runtime stability condition timed out");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("MCP child did not exit")), 10_000),
    ),
  ]);
}

const cleanStarts: string[] = [];
let finalSupervisorPid = 0;
let finalAppServerPid = 0;
try {
  store.close();
  for (let run = 0; run < 3; run += 1) {
    const connection = await ensureHostRunning(config);
    assert.equal(connection.reused, false);
    cleanStarts.push(connection.descriptor.ownershipGeneration);
    await stopManagedHost(config, false);
  }

  const entrypoint = path.resolve("dist", "messaging", "mcp_server.js");
  await access(entrypoint);
  const children = Array.from({ length: 3 }, () =>
    spawn(process.execPath, [entrypoint], {
      env: {
        ...process.env,
        BRIDGE_AGENT_ID: "stability-sender",
        BRIDGE_DATA_DIRECTORY: directory,
        BRIDGE_LOG_LEVEL: "error",
      },
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    }),
  );
  await waitFor(async () => {
    const status = await getHostStatus(config);
    return status.state === "ready" && status.health?.activeMcpClients === 3;
  });
  const concurrent = await getHostStatus(config);
  assert.equal(concurrent.state, "ready");
  assert.equal(concurrent.health?.activeMcpClients, 3);
  const concurrentGeneration = concurrent.descriptor?.ownershipGeneration;
  for (const child of children) child.stdin?.end();
  await Promise.all(children.map((child) => waitForExit(child)));
  await stopManagedHost(config, false);

  const crashed = await ensureHostRunning(config);
  const crashedSupervisorPid = crashed.descriptor.supervisorPid;
  const crashedAppServerPid = crashed.descriptor.appServerPid;
  const crashedGeneration = crashed.descriptor.ownershipGeneration;
  process.kill(crashedSupervisorPid, "SIGKILL");
  await waitFor(() => !alive(crashedSupervisorPid), 10_000);
  const recovered = await ensureHostRunning(config);
  assert.notEqual(recovered.descriptor.ownershipGeneration, crashedGeneration);
  const recoveryResult = recovered.health.lastRecoveryResult;
  assert.ok(
    recoveryResult === "authenticated-orphan-terminated" ||
      recoveryResult === "stale-descriptor-removed",
    `unexpected recovery result: ${recoveryResult}`,
  );
  assert.equal(alive(crashedAppServerPid), false);

  const rejectionStore = new BridgeDatabase(config.databasePath);
  const agents = new AgentRepository(rejectionStore, binding);
  new AgentRepository(rejectionStore).register({
    agentId: "unbound-target",
    displayName: "Unbound Target",
    threadId: "00000000-0000-4000-8000-000000000011",
    workspace: process.cwd(),
  });
  const appServer = new AppServerClient({
    url: recovered.url,
    authToken: recovered.authToken,
    reconnectLimit: 0,
  });
  await appServer.connect();
  const service = new MessagingService({
    senderAgentId: "stability-sender",
    instanceId: "stability-rejection",
    config: { ...config.messaging, turnTimeoutMs: config.appServer.turnTimeoutMs },
    appServer,
    agents,
    messages: new MessageRepository(rejectionStore),
    leases: new RecipientLeaseRepository(rejectionStore),
  });
  const rejected = await service.ask({
    recipient: "unbound-target",
    message: "must not be delivered",
    waitMs: 5_000,
  });
  assert.equal(rejected.status, "failed");
  if (rejected.status === "failed") assert.equal(rejected.errorCode, "UNSUPPORTED_THREAD_OWNER");
  await appServer.close();
  rejectionStore.close();
  finalSupervisorPid = recovered.descriptor.supervisorPid;
  finalAppServerPid = recovered.descriptor.appServerPid;
  await stopManagedHost(config, false);
  await waitFor(() => !alive(finalSupervisorPid) && !alive(finalAppServerPid), 10_000);
  const descriptorExists = await access(path.join(directory, "connection.json"))
    .then(() => true)
    .catch(() => false);
  const lockExists = await access(path.join(directory, "bootstrap.lock"))
    .then(() => true)
    .catch(() => false);
  assert.equal(descriptorExists, false);
  assert.equal(lockExists, false);
  process.stdout.write(
    `${JSON.stringify({ status: "passed", cleanStarts, concurrentGeneration, concurrentClients: 3, recovery: recoveryResult, ownershipRejection: "UNSUPPORTED_THREAD_OWNER", cleanup: "clean" })}\n`,
  );
} finally {
  await stopManagedHost(config, true).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
