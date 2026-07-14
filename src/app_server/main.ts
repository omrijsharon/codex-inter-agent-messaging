#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/index.js";
import { createLogger, LOG_EVENTS, redactSensitiveText } from "../logging/logger.js";
import { BridgeDatabase } from "../store/database.js";
import { BRIDGE_OWNER_MODE, BRIDGE_OWNER_PROTOCOL_VERSION, BRIDGE_VERSION } from "../version.js";
import { HostControlServer } from "./control.js";
import { AppServerClient } from "./client.js";
import {
  removeHostDescriptorIfOwned,
  type HostDescriptor,
  writeHostDescriptor,
} from "./descriptor.js";
import { SharedAppServerHost } from "./host.js";
import { resolveRuntimeIdentity } from "./identity.js";
import { SHARED_OWNER_CONNECTION_FILE } from "./runtime.js";

const VERSION = BRIDGE_VERSION;

export async function runHost(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    process.stdout.write(
      "Usage: codex-inter-agent-host\nStarts the authenticated shared Codex app-server transport owner.\n",
    );
    return;
  }
  if (arguments_.includes("--version") || arguments_.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (arguments_.length > 0) throw new Error(`unknown host option: ${arguments_[0]}`);

  const config = loadConfig();
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  const logPath = path.join(config.dataDirectory, "host.log");
  const logger = createLogger(config.logLevel, (line) =>
    appendFileSync(logPath, `${line}\n`, { encoding: "utf8", mode: 0o600 }),
  );
  const identity = await resolveRuntimeIdentity(config);
  const hostNonce = randomUUID();
  const ownershipGeneration = randomUUID();
  const host = new SharedAppServerHost({ appServer: config.appServer, logger });
  const connectionPath = path.join(config.dataDirectory, SHARED_OWNER_CONNECTION_FILE);
  const store = new BridgeDatabase(config.databasePath);
  const getActiveDeliveries = (): { messages: number; leases: number } => {
    const messages = store.database
      .prepare("SELECT count(*) AS count FROM messages WHERE status IN ('dispatching', 'running')")
      .get() as { count: number };
    const leases = store.database
      .prepare("SELECT count(*) AS count FROM recipient_leases WHERE expires_at > ?")
      .get(new Date().toISOString()) as { count: number };
    return { messages: messages.count, leases: leases.count };
  };
  let descriptor: HostDescriptor | null = null;
  let authToken: string | null = null;
  let authenticatedControl: HostControlServer | null = null;
  let stopReason = "signal";
  let resolveStop: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  try {
    const connection = await host.start();
    authToken = connection.authToken;
    const identityClient = new AppServerClient({
      url: connection.url,
      authToken: connection.authToken,
      reconnectLimit: 0,
    });
    let appServerUserAgent: string;
    try {
      await identityClient.connect();
      appServerUserAgent = identityClient.serverIdentity?.userAgent ?? "";
      if (!appServerUserAgent) throw new Error("app-server did not report its identity");
    } finally {
      await identityClient.close().catch(() => undefined);
    }
    authenticatedControl = new HostControlServer({
      authToken: connection.authToken,
      getDescriptor: () => {
        if (!descriptor) throw new Error("host descriptor is not ready");
        return descriptor;
      },
      getActiveDeliveries,
      bootstrapMode: process.env.BRIDGE_BOOTSTRAP_REASON ?? "manual",
      lastRecoveryResult: process.env.BRIDGE_LAST_RECOVERY_RESULT ?? null,
      logger,
      onShutdown: (reason) => {
        stopReason = reason;
        resolveStop?.();
      },
    });
    const controlUrl = await authenticatedControl.start();
    descriptor = {
      schemaVersion: 3,
      bridgeVersion: BRIDGE_VERSION,
      protocolVersion: BRIDGE_OWNER_PROTOCOL_VERSION,
      ownerMode: BRIDGE_OWNER_MODE,
      installationId: identity.installationId,
      databaseId: identity.databaseId,
      ownershipGeneration,
      transport: "websocket",
      capabilityTokenMode: "capability-token",
      appServerUserAgent,
      hostNonce,
      supervisorPid: process.pid,
      appServerPid: connection.pid,
      url: connection.url,
      controlUrl,
      startedAt: connection.startedAt,
    };
    await writeHostDescriptor(connectionPath, descriptor, connection.authToken);
    logger.info(LOG_EVENTS.bridgeReady, {
      bootstrapMode: process.env.BRIDGE_BOOTSTRAP_REASON ?? "manual",
      hostPid: process.pid,
      appServerPid: connection.pid,
      hostNonce,
      ownershipGeneration,
    });
    process.stdout.write(
      `${JSON.stringify({ status: "ready", url: connection.url, pid: process.pid, hostNonce })}\n`,
    );

    const signal = (): void => {
      stopReason = "signal";
      resolveStop?.();
    };
    process.once("SIGINT", signal);
    process.once("SIGTERM", signal);
    await stopped;
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    logger.info(LOG_EVENTS.bridgeStopped, { shutdownReason: stopReason, hostNonce });
    await authenticatedControl.stop();
    authenticatedControl = null;
  } finally {
    await authenticatedControl?.stop().catch(() => undefined);
    await host.stop().catch(() => undefined);
    store.close();
    if (descriptor && authToken) {
      await removeHostDescriptorIfOwned(connectionPath, descriptor.hostNonce, authToken).catch(
        () => undefined,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHost().catch((error: unknown) => {
    const message = redactSensitiveText(error instanceof Error ? error.message : "host failed");
    try {
      const config = loadConfig();
      appendFileSync(
        path.join(config.dataDirectory, "host.log"),
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "host.start_failed", error: message })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // A manual foreground launch still receives stderr below.
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
