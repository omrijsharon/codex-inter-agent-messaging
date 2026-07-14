import { describe, expect, it, vi } from "vitest";
import type { ManagedHostConnection } from "../../src/app_server/bootstrap.js";
import { runCli, type HostLifecycle, type RemoteCodexLauncher } from "../../src/cli/main.js";

describe("production CLI foundation", () => {
  it("runs help and version entry points", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runCli(["--help"])).resolves.toBe(0);
    await expect(runCli(["--version"])).resolves.toBe(0);
    expect(output.mock.calls.flat().join("")).toContain("codex-inter-agent 0.4.0");
    output.mockRestore();
  });

  it("routes host status, start, stop, and restart without creating the admin runtime", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const calls: string[] = [];
    const descriptor = {
      schemaVersion: 3 as const,
      bridgeVersion: "0.4.0",
      protocolVersion: "1",
      ownerMode: "bridge-managed" as const,
      installationId: "installation-test",
      databaseId: "database-test",
      ownershipGeneration: "00000000-0000-4000-8000-000000000003",
      transport: "websocket" as const,
      capabilityTokenMode: "capability-token" as const,
      appServerUserAgent: "codex-cli/0.144.0-alpha.4",
      hostNonce: "host-nonce-0000000001",
      supervisorPid: 100,
      appServerPid: 101,
      url: "ws://127.0.0.1:40001",
      controlUrl: "http://127.0.0.1:40002",
      startedAt: new Date().toISOString(),
    };
    const connection = {
      url: descriptor.url,
      authToken: "t".repeat(48),
      descriptor,
      health: {
        ...descriptor,
        status: "ready" as const,
        uptimeMs: 1,
        activeMcpClients: 0,
        activeDeliveries: { messages: 0, leases: 0 },
        bootstrapMode: "test",
        lastRecoveryResult: null,
      },
      reused: true,
    } satisfies ManagedHostConnection;
    const lifecycle: HostLifecycle = {
      status: () => {
        calls.push("status");
        return Promise.resolve({ state: "ready", descriptor, health: connection.health });
      },
      start: () => {
        calls.push("start");
        return Promise.resolve(connection);
      },
      stop: (force) => {
        calls.push(`stop:${force}`);
        return Promise.resolve({ status: "stopped" });
      },
      restart: (force) => {
        calls.push(`restart:${force}`);
        return Promise.resolve(connection);
      },
    };
    const noRuntime = () => Promise.reject(new Error("admin runtime must not be created"));

    await runCli(["host", "status"], noRuntime, lifecycle);
    await runCli(["host", "start"], noRuntime, lifecycle);
    await runCli(["host", "stop", "--force"], noRuntime, lifecycle);
    await runCli(["host", "restart"], noRuntime, lifecycle);
    expect(calls).toEqual(["status", "start", "stop:true", "restart:false"]);
    expect(output.mock.calls.flat().join("")).not.toContain("t".repeat(48));
    await expect(runCli(["host", "status", "--force"], noRuntime, lifecycle)).rejects.toThrow(
      /supported only/,
    );
    output.mockRestore();
  });

  it("launches one-action remote Codex against the authenticated managed owner", async () => {
    const descriptor = {
      schemaVersion: 3 as const,
      bridgeVersion: "0.4.0",
      protocolVersion: "1",
      ownerMode: "bridge-managed" as const,
      installationId: "installation-test",
      databaseId: "database-test",
      ownershipGeneration: "00000000-0000-4000-8000-000000000003",
      transport: "websocket" as const,
      capabilityTokenMode: "capability-token" as const,
      appServerUserAgent: "codex-cli/0.144.0-alpha.4",
      hostNonce: "host-nonce-0000000001",
      supervisorPid: 100,
      appServerPid: 101,
      url: "ws://127.0.0.1:40001",
      controlUrl: "http://127.0.0.1:40002",
      startedAt: new Date().toISOString(),
    };
    const connection: ManagedHostConnection = {
      url: descriptor.url,
      authToken: "secret-token-not-for-arguments".repeat(2),
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
      reused: true,
    };
    const lifecycle: HostLifecycle = {
      status: () => Promise.resolve({ state: "ready", descriptor, health: connection.health }),
      start: () => Promise.resolve(connection),
      stop: () => Promise.resolve({ status: "stopped" }),
      restart: () => Promise.resolve(connection),
    };
    const calls: Array<{ connection: ManagedHostConnection; arguments_: readonly string[] }> = [];
    const launcher: RemoteCodexLauncher = {
      launch(value, arguments_) {
        calls.push({ connection: value, arguments_ });
        return Promise.resolve(17);
      },
    };

    await expect(
      runCli(
        ["connect", "--", "resume", "thread-1"],
        () => Promise.reject(new Error("admin runtime must not be created")),
        lifecycle,
        launcher,
      ),
    ).resolves.toBe(17);
    expect(calls).toEqual([{ connection, arguments_: ["resume", "thread-1"] }]);
  });
});
