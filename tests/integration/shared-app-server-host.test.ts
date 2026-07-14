import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AppServerClient } from "../../src/app_server/client.js";
import { SharedAppServerHost } from "../../src/app_server/host.js";
import { AdminService, AppServerThreadVerifier } from "../../src/cli/admin_service.js";
import { loadConfig } from "../../src/config/index.js";
import { createLogger } from "../../src/logging/logger.js";
import { BridgeDatabase } from "../../src/store/database.js";
import { AgentRepository } from "../../src/store/repositories.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("bridge-managed shared app-server host", () => {
  it("starts one authenticated owner, accepts initialize, and shuts down", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-host-"));
    cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const config = loadConfig({ BRIDGE_DATA_DIRECTORY: dataDirectory }, os.homedir());
    const host = new SharedAppServerHost({
      appServer: config.appServer,
      logger: createLogger("error", () => undefined),
      workingDirectory: dataDirectory,
    });
    cleanup.push(() => host.stop());

    const connection = await host.start();
    expect(host.running).toBe(true);
    expect(connection.url).not.toContain(":0");

    await expect(
      new Promise<void>((resolve, reject) => {
        const unauthorized = new WebSocket(connection.url, {
          headers: { Authorization: "Bearer wrong-capability" },
        });
        unauthorized.once("open", () => {
          unauthorized.close();
          resolve();
        });
        unauthorized.once("unexpected-response", (_request, response) => {
          unauthorized.terminate();
          reject(new Error(`unauthorized status ${response.statusCode}`));
        });
        unauthorized.once("error", reject);
      }),
    ).rejects.toThrow(/unauthorized status (401|403)/);

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = new WebSocket(connection.url, {
        headers: { Authorization: `Bearer ${connection.authToken}` },
      });
      socket.once("error", reject);
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "host-integration-test", version: "0.1.0" },
              capabilities: { experimentalApi: true },
            },
          }),
        );
      });
      socket.once("message", (data) => {
        socket.close();
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(new Uint8Array(data)).toString("utf8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      });
    });
    expect(response).toHaveProperty("result");

    const client = new AppServerClient({
      url: connection.url,
      authToken: connection.authToken,
      reconnectLimit: 0,
    });
    cleanup.push(() => client.close());
    await client.connect();
    const threads = await client.listThreads();
    expect(threads).toHaveProperty("data");
    const store = new BridgeDatabase(path.join(dataDirectory, "registry.sqlite3"));
    cleanup.push(() => {
      store.close();
      return Promise.resolve();
    });
    const admin = new AdminService(new AgentRepository(store), new AppServerThreadVerifier(client));
    const registered = await admin.register({
      agentId: "prepare-inter-agent-thread",
      displayName: "Prepare inter-agent thread",
      threadId: "019f6082-fd66-7da2-aa9f-b6461c2c486d",
      workspace: dataDirectory,
    });
    expect(registered).toMatchObject({ generation: 1, status: "active" });
    await client.close();

    await host.stop();
    expect(host.running).toBe(false);
  }, 60_000);
});
