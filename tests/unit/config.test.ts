import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";

describe("loadConfig", () => {
  it("provides explicit safe defaults", () => {
    const config = loadConfig({}, "C:/test-home");
    expect(config.dataDirectory).toBe(path.resolve("C:/test-home/.codex-inter-agent"));
    expect(config.appServer.listenUrl).toBe("ws://127.0.0.1:0");
    expect(config.appServer.requestTimeoutMs).toBe(30_000);
    expect(config.messaging.synchronousWaitMs).toBe(120_000);
    expect(config.messaging.maxMessageBytes).toBe(65_536);
  });

  it("loads bounded operator overrides", () => {
    const config = loadConfig(
      {
        BRIDGE_LOG_LEVEL: "debug",
        BRIDGE_BUSY_POLL_MS: "250",
        BRIDGE_APP_SERVER_LISTEN_URL: "wss://bridge.example.test:8443",
        BRIDGE_ALLOW_REMOTE_APP_SERVER: "true",
        BRIDGE_ACL_DEFAULT_POLICY: "deny",
      },
      "C:/test-home",
    );
    expect(config.logLevel).toBe("debug");
    expect(config.messaging.busyPollMs).toBe(250);
    expect(config.appServer.listenUrl).toBe("wss://bridge.example.test:8443");
    expect(config.security.aclDefaultPolicy).toBe("deny");
  });

  it("rejects non-loopback unencrypted transport", () => {
    expect(() =>
      loadConfig({ BRIDGE_APP_SERVER_LISTEN_URL: "ws://192.0.2.10:8080" }, "C:/test-home"),
    ).toThrow(/loopback/);
  });

  it("requires an explicit opt-in for remote TLS transport", () => {
    expect(() =>
      loadConfig(
        { BRIDGE_APP_SERVER_LISTEN_URL: "wss://bridge.example.test:8443" },
        "C:/test-home",
      ),
    ).toThrow(/BRIDGE_ALLOW_REMOTE_APP_SERVER/);
  });

  it("rejects invalid numeric limits", () => {
    expect(() => loadConfig({ BRIDGE_MAX_HOP_COUNT: "0" }, "C:/test-home")).toThrow(
      /BRIDGE_MAX_HOP_COUNT/,
    );
  });
});
