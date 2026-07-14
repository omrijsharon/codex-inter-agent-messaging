import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostControlServer,
  probeHostControl,
  registerHostClient,
  requestHostShutdown,
} from "../../src/app_server/control.js";
import type { HostDescriptor } from "../../src/app_server/descriptor.js";

const servers: HostControlServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function descriptor(controlUrl = "http://127.0.0.1:1"): HostDescriptor {
  return {
    schemaVersion: 3,
    bridgeVersion: "0.4.0",
    protocolVersion: "1",
    ownerMode: "bridge-managed",
    installationId: randomUUID(),
    databaseId: "db-test",
    ownershipGeneration: randomUUID(),
    transport: "websocket",
    capabilityTokenMode: "capability-token",
    appServerUserAgent: "codex-cli/0.144.0-alpha.4",
    hostNonce: randomUUID(),
    supervisorPid: process.pid,
    appServerPid: process.pid,
    url: "ws://127.0.0.1:12345",
    controlUrl,
    startedAt: new Date().toISOString(),
  };
}

async function fixture(active = { messages: 0, leases: 0 }) {
  const token = "t".repeat(48);
  let current = descriptor();
  let shutdownReason: string | null = null;
  const server = new HostControlServer({
    authToken: token,
    getDescriptor: () => current,
    getActiveDeliveries: () => active,
    bootstrapMode: "test",
    onShutdown: (reason) => {
      shutdownReason = reason;
    },
  });
  servers.push(server);
  const controlUrl = await server.start();
  current = { ...current, controlUrl };
  return { server, token, descriptor: current, shutdownReason: () => shutdownReason };
}

describe("authenticated host control", () => {
  it("echoes the authenticated descriptor identity and rejects a wrong token", async () => {
    const value = await fixture();
    const health = await probeHostControl(value.descriptor, value.token);
    expect(health).toMatchObject({
      status: "ready",
      hostNonce: value.descriptor.hostNonce,
      bootstrapMode: "test",
      activeMcpClients: 0,
      activeDeliveries: { messages: 0, leases: 0 },
    });
    await expect(probeHostControl(value.descriptor, "x".repeat(48))).rejects.toMatchObject({
      code: "HOST_AUTH_FAILED",
    });
  });

  it("uses token-bound MCP client leases for observable client counts", async () => {
    const value = await fixture();
    const lease = await registerHostClient(
      value.descriptor,
      value.token,
      `mcp_${randomUUID()}`,
      value.descriptor.appServerUserAgent,
    );
    expect((await probeHostControl(value.descriptor, value.token)).activeMcpClients).toBe(1);
    await lease.close();
    expect((await probeHostControl(value.descriptor, value.token)).activeMcpClients).toBe(0);
  });

  it("rejects an MCP client whose observed app-server identity differs", async () => {
    const value = await fixture();
    await expect(
      registerHostClient(value.descriptor, value.token, `mcp_${randomUUID()}`, "other-codex"),
    ).rejects.toMatchObject({ code: "OWNER_CAPABILITY_MISMATCH" });
    expect((await probeHostControl(value.descriptor, value.token)).activeMcpClients).toBe(0);
  });

  it("binds shutdown to the expected host nonce", async () => {
    const value = await fixture();
    await expect(
      requestHostShutdown({ ...value.descriptor, hostNonce: randomUUID() }, value.token, false),
    ).rejects.toMatchObject({ code: "HOST_IDENTITY_MISMATCH" });
    expect(value.shutdownReason()).toBeNull();
  });

  it("refuses active delivery shutdown unless the operator forces it", async () => {
    const value = await fixture({ messages: 1, leases: 0 });
    await expect(requestHostShutdown(value.descriptor, value.token, false)).rejects.toMatchObject({
      code: "HOST_ACTIVE_DELIVERIES",
    });
    await requestHostShutdown(value.descriptor, value.token, true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(value.shutdownReason()).toBe("operator-force");
    expect((await probeHostControl(value.descriptor, value.token)).status).toBe("stopping");
  });
});
