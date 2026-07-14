import os from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface BridgeConfig {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly logLevel: LogLevel;
  readonly appServer: {
    readonly listenUrl: string;
    readonly tokenPath: string;
    readonly startupTimeoutMs: number;
    readonly requestTimeoutMs: number;
    readonly turnTimeoutMs: number;
    readonly reconnectLimit: number;
    readonly allowRemote: boolean;
  };
  readonly messaging: {
    readonly synchronousWaitMs: number;
    readonly busyPollMs: number;
    readonly busyWaitMs: number;
    readonly maxMessageBytes: number;
    readonly maxQueueDepth: number;
    readonly maxHopCount: number;
    readonly maxCallChainLength: number;
    readonly messageTtlMs: number;
    readonly maxRetryAttempts: number;
    readonly retryBaseMs: number;
    readonly retryMaximumMs: number;
    readonly retryJitterPercent: number;
    readonly maxConcurrentDeliveries: number;
    readonly maxGroupFanout: number;
  };
  readonly security: {
    readonly aclDefaultPolicy: "allow" | "deny";
  };
}

const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {},
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function webSocketUrl(value: string, allowRemote: boolean): string {
  const url = new URL(value);
  if (!new Set(["ws:", "wss:"]).has(url.protocol)) {
    throw new Error("BRIDGE_APP_SERVER_LISTEN_URL must use ws: or wss:");
  }
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
  if (url.protocol === "ws:" && !loopback) {
    throw new Error("unencrypted app-server transport must bind to loopback");
  }
  if (!loopback && !allowRemote) {
    throw new Error("remote app-server transport requires BRIDGE_ALLOW_REMOTE_APP_SERVER=true");
  }
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): BridgeConfig {
  const dataDirectory = path.resolve(
    env.BRIDGE_DATA_DIRECTORY ?? path.join(homeDirectory, ".codex-inter-agent"),
  );
  const rawLevel = env.BRIDGE_LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.has(rawLevel as LogLevel)) {
    throw new Error("BRIDGE_LOG_LEVEL must be debug, info, warn, or error");
  }
  const aclDefaultPolicy = env.BRIDGE_ACL_DEFAULT_POLICY ?? "allow";
  if (!new Set(["allow", "deny"]).has(aclDefaultPolicy)) {
    throw new Error("BRIDGE_ACL_DEFAULT_POLICY must be allow or deny");
  }
  const allowRemote = env.BRIDGE_ALLOW_REMOTE_APP_SERVER === "true";

  return {
    dataDirectory,
    databasePath: path.resolve(
      env.BRIDGE_DATABASE_PATH ?? path.join(dataDirectory, "bridge.sqlite3"),
    ),
    logLevel: rawLevel as LogLevel,
    appServer: {
      listenUrl: webSocketUrl(env.BRIDGE_APP_SERVER_LISTEN_URL ?? "ws://127.0.0.1:0", allowRemote),
      tokenPath: path.resolve(
        env.BRIDGE_APP_SERVER_TOKEN_PATH ?? path.join(dataDirectory, "app-server.token"),
      ),
      startupTimeoutMs: integer(env, "BRIDGE_APP_SERVER_STARTUP_TIMEOUT_MS", 30_000, {
        maximum: 300_000,
      }),
      requestTimeoutMs: integer(env, "BRIDGE_APP_SERVER_REQUEST_TIMEOUT_MS", 30_000, {
        maximum: 300_000,
      }),
      turnTimeoutMs: integer(env, "BRIDGE_APP_SERVER_TURN_TIMEOUT_MS", 180_000, {
        maximum: 1_800_000,
      }),
      reconnectLimit: integer(env, "BRIDGE_APP_SERVER_RECONNECT_LIMIT", 5, { maximum: 100 }),
      allowRemote,
    },
    messaging: {
      synchronousWaitMs: integer(env, "BRIDGE_SYNCHRONOUS_WAIT_MS", 120_000, {
        maximum: 300_000,
      }),
      busyPollMs: integer(env, "BRIDGE_BUSY_POLL_MS", 100, { maximum: 60_000 }),
      busyWaitMs: integer(env, "BRIDGE_BUSY_WAIT_MS", 120_000, { maximum: 1_800_000 }),
      maxMessageBytes: integer(env, "BRIDGE_MAX_MESSAGE_BYTES", 64 * 1024, {
        maximum: 1024 * 1024,
      }),
      maxQueueDepth: integer(env, "BRIDGE_MAX_QUEUE_DEPTH", 100, { maximum: 10_000 }),
      maxHopCount: integer(env, "BRIDGE_MAX_HOP_COUNT", 8, { maximum: 100 }),
      maxCallChainLength: integer(env, "BRIDGE_MAX_CALL_CHAIN_LENGTH", 16, { maximum: 100 }),
      messageTtlMs: integer(env, "BRIDGE_MESSAGE_TTL_MS", 15 * 60_000, {
        maximum: 24 * 60 * 60_000,
      }),
      maxRetryAttempts: integer(env, "BRIDGE_MAX_RETRY_ATTEMPTS", 5, { maximum: 100 }),
      retryBaseMs: integer(env, "BRIDGE_RETRY_BASE_MS", 250, { maximum: 60_000 }),
      retryMaximumMs: integer(env, "BRIDGE_RETRY_MAXIMUM_MS", 10_000, { maximum: 300_000 }),
      retryJitterPercent: integer(env, "BRIDGE_RETRY_JITTER_PERCENT", 20, {
        minimum: 0,
        maximum: 100,
      }),
      maxConcurrentDeliveries: integer(env, "BRIDGE_MAX_CONCURRENT_DELIVERIES", 8, {
        maximum: 1_000,
      }),
      maxGroupFanout: integer(env, "BRIDGE_MAX_GROUP_FANOUT", 20, { maximum: 1_000 }),
    },
    security: { aclDefaultPolicy: aclDefaultPolicy as "allow" | "deny" },
  };
}
