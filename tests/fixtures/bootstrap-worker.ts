import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureHostRunning, type ManagedHostConnection } from "../../src/app_server/bootstrap.js";
import type { RuntimeIdentity } from "../../src/app_server/identity.js";
import { loadConfig } from "../../src/config/index.js";
import { createLogger } from "../../src/logging/logger.js";
import {
  BRIDGE_OWNER_MODE,
  BRIDGE_OWNER_PROTOCOL_VERSION,
  BRIDGE_VERSION,
} from "../../src/version.js";

const dataDirectory = process.argv[2];
if (!dataDirectory) throw new Error("bootstrap worker requires a data directory");
const readyPath = path.join(dataDirectory, "fake-host.json");
const launchPath = path.join(dataDirectory, "fake-launches.ndjson");
const config = loadConfig({ BRIDGE_DATA_DIRECTORY: dataDirectory }, process.cwd());

function connection(
  identity: RuntimeIdentity,
  hostNonce: string,
): Omit<ManagedHostConnection, "reused"> {
  const descriptor = {
    schemaVersion: 3 as const,
    bridgeVersion: BRIDGE_VERSION,
    protocolVersion: BRIDGE_OWNER_PROTOCOL_VERSION,
    ownerMode: BRIDGE_OWNER_MODE,
    installationId: identity.installationId,
    databaseId: identity.databaseId,
    ownershipGeneration: "00000000-0000-4000-8000-000000000003",
    transport: "websocket" as const,
    capabilityTokenMode: "capability-token" as const,
    appServerUserAgent: "codex-cli/0.144.0-alpha.4",
    hostNonce,
    supervisorPid: 4242,
    appServerPid: 4243,
    url: "ws://127.0.0.1:41001",
    controlUrl: "http://127.0.0.1:41002",
    startedAt: new Date(0).toISOString(),
  };
  return {
    url: descriptor.url,
    authToken: "t".repeat(48),
    descriptor,
    health: {
      ...descriptor,
      status: "ready",
      uptimeMs: 1,
      activeMcpClients: 0,
      activeDeliveries: { messages: 0, leases: 0 },
      bootstrapMode: "multiprocess-test",
      lastRecoveryResult: null,
    },
  };
}

const result = await ensureHostRunning(config, {
  logger: createLogger("error", () => undefined),
  probeHost: async (_config, identity) => {
    try {
      const value = JSON.parse(await readFile(readyPath, "utf8")) as { hostNonce: string };
      return connection(identity, value.hostNonce);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  launchHost: async (_reason, correlationId) => {
    const hostNonce = "multiprocess-host-nonce-0001";
    await appendFile(
      launchPath,
      `${JSON.stringify({ pid: process.pid, correlationId })}\n`,
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(readyPath, JSON.stringify({ hostNonce }), "utf8");
    return process.pid;
  },
});

process.stdout.write(
  `${JSON.stringify({ reused: result.reused, hostNonce: result.descriptor.hostNonce })}\n`,
);
