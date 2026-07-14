import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureHostRunning,
  HostBootstrapError,
  type ManagedHostConnection,
} from "../../src/app_server/bootstrap.js";
import type { RuntimeIdentity } from "../../src/app_server/identity.js";
import { loadConfig, type BridgeConfig } from "../../src/config/index.js";
import { createLogger } from "../../src/logging/logger.js";
import {
  BRIDGE_OWNER_MODE,
  BRIDGE_OWNER_PROTOCOL_VERSION,
  BRIDGE_VERSION,
} from "../../src/version.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function config(startupTimeoutMs = 1_000): Promise<BridgeConfig> {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "bridge-bootstrap-unit-"));
  temporary.push(dataDirectory);
  return loadConfig(
    {
      BRIDGE_DATA_DIRECTORY: dataDirectory,
      BRIDGE_APP_SERVER_STARTUP_TIMEOUT_MS: String(startupTimeoutMs),
    },
    os.homedir(),
  );
}

function healthy(
  identity: RuntimeIdentity,
  hostNonce = randomUUID(),
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
    supervisorPid: 100,
    appServerPid: 101,
    url: "ws://127.0.0.1:40001",
    controlUrl: "http://127.0.0.1:40002",
    startedAt: new Date().toISOString(),
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
      bootstrapMode: "test",
      lastRecoveryResult: null,
    },
  };
}

const logger = createLogger("error", () => undefined);

describe("ensureHostRunning", () => {
  it("takes the authenticated healthy-host fast path without launching", async () => {
    const value = await config();
    let launches = 0;
    const result = await ensureHostRunning(value, {
      logger,
      probeHost: (_config, identity) => Promise.resolve(healthy(identity)),
      launchHost: () => Promise.resolve(++launches),
    });
    expect(result.reused).toBe(true);
    expect(launches).toBe(0);
  });

  it("converges three simultaneous starters on one host through lock and double-check", async () => {
    const value = await config(2_000);
    let launches = 0;
    let running = false;
    const hostNonce = randomUUID();
    const options = {
      logger,
      probeHost: (_config: BridgeConfig, identity: RuntimeIdentity) =>
        Promise.resolve(running ? healthy(identity, hostNonce) : null),
      launchHost: async () => {
        launches += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        running = true;
        return 777;
      },
    };
    const results = await Promise.all([
      ensureHostRunning(value, options),
      ensureHostRunning(value, options),
      ensureHostRunning(value, options),
    ]);
    expect(launches).toBe(1);
    expect(new Set(results.map((result) => result.descriptor.hostNonce)).size).toBe(1);
    expect(results.filter((result) => !result.reused)).toHaveLength(1);
  });

  it("returns a typed startup failure when the detached launch fails", async () => {
    const value = await config();
    await expect(
      ensureHostRunning(value, {
        logger,
        probeHost: () => Promise.resolve(null),
        launchHost: () => Promise.reject(new Error("spawn failed")),
      }),
    ).rejects.toMatchObject({ code: "HOST_START_FAILED" });
  });

  it("bounds authenticated readiness waiting", async () => {
    const value = await config(30);
    await expect(
      ensureHostRunning(value, {
        logger,
        probeHost: () => Promise.resolve(null),
        launchHost: () => Promise.resolve(888),
      }),
    ).rejects.toMatchObject({ code: "HOST_START_TIMEOUT" });
  });

  it.each(["HOST_INCOMPATIBLE", "HOST_AUTH_FAILED"] as const)(
    "fails closed on %s without launching a second owner",
    async (code) => {
      const value = await config();
      let launches = 0;
      await expect(
        ensureHostRunning(value, {
          logger,
          probeHost: () => Promise.reject(new HostBootstrapError(code, "rejected owner")),
          launchHost: () => Promise.resolve(++launches),
        }),
      ).rejects.toMatchObject({ code });
      expect(launches).toBe(0);
    },
  );
});
