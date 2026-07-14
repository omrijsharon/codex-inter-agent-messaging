import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "../config/index.js";

export const SHARED_OWNER_CONNECTION_FILE = "connection.json";

export async function resolveSharedOwnerUrl(config: BridgeConfig): Promise<string> {
  if (new URL(config.appServer.listenUrl).port !== "0") return config.appServer.listenUrl;
  const descriptorPath = path.join(config.dataDirectory, SHARED_OWNER_CONNECTION_FILE);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(descriptorPath, "utf8"));
  } catch {
    throw new Error(`shared app-server is not ready; start codex-inter-agent-host first`);
  }
  const candidate = (value as { url?: unknown })?.url;
  if (typeof candidate !== "string")
    throw new Error("shared owner connection descriptor is invalid");
  const url = new URL(candidate);
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
  if (!new Set(["ws:", "wss:"]).has(url.protocol)) {
    throw new Error("shared owner descriptor has an invalid protocol");
  }
  if (!loopback && (!config.appServer.allowRemote || url.protocol !== "wss:")) {
    throw new Error("shared owner descriptor violates remote transport policy");
  }
  return url.toString().replace(/\/$/, "");
}
