#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../logging/logger.js";
import { BRIDGE_VERSION } from "../version.js";
import { SharedAppServerHost } from "./host.js";
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
  await mkdir(config.dataDirectory, { recursive: true });
  const logger = createLogger(config.logLevel);
  const host = new SharedAppServerHost({ appServer: config.appServer, logger });
  const connectionPath = path.join(config.dataDirectory, SHARED_OWNER_CONNECTION_FILE);
  const connection = await host.start();
  await writeFile(
    connectionPath,
    `${JSON.stringify({ version: 1, url: connection.url, pid: process.pid })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write(
    `${JSON.stringify({ status: "ready", url: connection.url, pid: process.pid })}\n`,
  );

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await host.stop();
  await rm(connectionPath, { force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHost().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "host failed"}\n`);
    process.exitCode = 1;
  });
}
