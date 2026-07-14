import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeConfig } from "../config/index.js";
import { createLogger, LOG_EVENTS, type Logger } from "../logging/logger.js";
import { BRIDGE_OWNER_MODE, BRIDGE_OWNER_PROTOCOL_VERSION, BRIDGE_VERSION } from "../version.js";
import { AppServerClient } from "./client.js";
import { acquireBootstrapLock } from "./bootstrap_lock.js";
import { probeHostControl, requestHostShutdown, type HostControlHealth } from "./control.js";
import {
  HostDescriptorError,
  readHostDescriptor,
  removeHostDescriptorIfOwned,
  type HostDescriptor,
} from "./descriptor.js";
import { resolveRuntimeIdentity, type RuntimeIdentity } from "./identity.js";
import { SHARED_OWNER_CONNECTION_FILE } from "./runtime.js";

export const BOOTSTRAP_LOCK_FILE = "bootstrap.lock";

export type HostBootstrapErrorCode =
  | "HOST_START_TIMEOUT"
  | "HOST_LOCK_TIMEOUT"
  | "HOST_DESCRIPTOR_INVALID"
  | "HOST_AUTH_FAILED"
  | "HOST_INCOMPATIBLE"
  | "HOST_PERMISSION_DENIED"
  | "HOST_START_FAILED"
  | "HOST_STOP_TIMEOUT"
  | "HOST_BUSY"
  | "HOST_ACTIVE_DELIVERIES";

export class HostBootstrapError extends Error {
  readonly code: HostBootstrapErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: HostBootstrapErrorCode,
    message: string,
    detail: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostBootstrapError";
    this.code = code;
    this.detail = detail;
  }
}

export interface ManagedHostConnection {
  readonly url: string;
  readonly authToken: string;
  readonly descriptor: HostDescriptor;
  readonly health: HostControlHealth;
  readonly reused: boolean;
}

export interface HostStatus {
  readonly state: "stopped" | "ready" | "stale" | "incompatible" | "failed";
  readonly descriptor?: HostDescriptor;
  readonly health?: HostControlHealth;
  readonly code?: HostBootstrapErrorCode;
  readonly error?: string;
}

export interface HostBootstrapOptions {
  readonly logger?: Logger;
  readonly launchHost?: (
    reason: string,
    correlationId: string,
    recoveryResult?: string,
  ) => Promise<number>;
  readonly probeHost?: (
    config: BridgeConfig,
    identity: RuntimeIdentity,
  ) => Promise<Omit<ManagedHostConnection, "reused"> | null>;
}

function bootstrapError(error: unknown): HostBootstrapError {
  if (error instanceof HostBootstrapError) return error;
  const candidate = error as { code?: unknown; status?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  if (code === "HOST_LOCK_TIMEOUT" || code === "HOST_PERMISSION_DENIED") {
    return new HostBootstrapError(
      code,
      error instanceof Error ? error.message : code,
      {},
      {
        cause: error,
      },
    );
  }
  if (code === "HOST_BUSY" || code === "HOST_ACTIVE_DELIVERIES") {
    return new HostBootstrapError(
      code,
      error instanceof Error ? error.message : code,
      {},
      {
        cause: error,
      },
    );
  }
  return new HostBootstrapError(
    "HOST_START_FAILED",
    error instanceof Error ? error.message : "host startup failed",
    {},
    { cause: error },
  );
}

function descriptorPath(config: BridgeConfig): string {
  return path.join(config.dataDirectory, SHARED_OWNER_CONNECTION_FILE);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function tokenMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function readToken(config: BridgeConfig): Promise<string | null> {
  try {
    const token = (await readFile(config.appServer.tokenPath, "utf8")).trim();
    if (token.length < 32) {
      throw new HostBootstrapError("HOST_AUTH_FAILED", "host capability token is invalid");
    }
    return token;
  } catch (error) {
    if (tokenMissing(error)) return null;
    throw error;
  }
}

function assertCompatible(descriptor: HostDescriptor, identity: RuntimeIdentity): void {
  const expected = {
    bridgeVersion: BRIDGE_VERSION,
    protocolVersion: BRIDGE_OWNER_PROTOCOL_VERSION,
    ownerMode: BRIDGE_OWNER_MODE,
    installationId: identity.installationId,
    databaseId: identity.databaseId,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (descriptor[key as keyof HostDescriptor] !== value) {
      throw new HostBootstrapError(
        "HOST_INCOMPATIBLE",
        `running host ${key} is incompatible; stop it explicitly before upgrade or reconfiguration`,
        { field: key },
      );
    }
  }
}

function assertHealthIdentity(descriptor: HostDescriptor, health: HostControlHealth): void {
  for (const key of [
    "hostNonce",
    "installationId",
    "databaseId",
    "bridgeVersion",
    "protocolVersion",
    "ownerMode",
    "ownershipGeneration",
    "transport",
    "capabilityTokenMode",
    "appServerUserAgent",
    "url",
  ] as const) {
    if (health[key] !== descriptor[key]) {
      throw new HostBootstrapError("HOST_AUTH_FAILED", `host health identity mismatch: ${key}`);
    }
  }
}

export async function probeManagedHost(
  config: BridgeConfig,
  identity: RuntimeIdentity,
): Promise<Omit<ManagedHostConnection, "reused"> | null> {
  const token = await readToken(config);
  if (!token) {
    try {
      await access(descriptorPath(config));
      throw new HostBootstrapError(
        "HOST_AUTH_FAILED",
        "a host descriptor exists but its capability token is missing",
      );
    } catch (error) {
      if (error instanceof HostBootstrapError) throw error;
      if (!tokenMissing(error)) throw error;
      return null;
    }
  }
  const read = await readHostDescriptor(descriptorPath(config), token);
  if (read.status === "missing") return null;
  if (read.status === "invalid") {
    if (read.error.code === "DESCRIPTOR_INCOMPATIBLE") {
      throw new HostBootstrapError(
        "HOST_INCOMPATIBLE",
        read.error.message,
        {},
        {
          cause: read.error,
        },
      );
    }
    if (read.error.code === "SIGNATURE_INVALID") {
      throw new HostBootstrapError(
        "HOST_AUTH_FAILED",
        read.error.message,
        {},
        {
          cause: read.error,
        },
      );
    }
    return null;
  }
  const descriptor = read.descriptor;
  assertCompatible(descriptor, identity);
  let health: HostControlHealth;
  try {
    health = await probeHostControl(descriptor, token);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (status === 401 || status === 403) {
      throw new HostBootstrapError(
        "HOST_AUTH_FAILED",
        "host control authentication failed",
        {},
        {
          cause: error,
        },
      );
    }
    return null;
  }
  assertHealthIdentity(descriptor, health);
  if (health.status !== "ready") return null;
  const client = new AppServerClient({
    url: descriptor.url,
    authToken: token,
    requestTimeoutMs: Math.min(config.appServer.requestTimeoutMs, 5_000),
    reconnectLimit: 0,
  });
  try {
    await client.connect();
    if (client.serverIdentity?.userAgent !== descriptor.appServerUserAgent) {
      throw new HostBootstrapError(
        "HOST_INCOMPATIBLE",
        "live app-server identity does not match the authenticated owner descriptor",
      );
    }
  } catch (error) {
    if (error instanceof HostBootstrapError) throw error;
    return null;
  } finally {
    await client.close().catch(() => undefined);
  }
  return { url: descriptor.url, authToken: token, descriptor, health };
}

async function recoverStaleManagedHost(
  config: BridgeConfig,
  identity: RuntimeIdentity,
  logger: Logger,
  correlationId: string,
): Promise<string | null> {
  const token = await readToken(config);
  if (!token) return null;
  const read = await readHostDescriptor(descriptorPath(config), token);
  if (read.status !== "valid") return null;
  const descriptor = read.descriptor;
  assertCompatible(descriptor, identity);
  if (processAlive(descriptor.supervisorPid)) {
    throw new HostBootstrapError(
      "HOST_BUSY",
      "the authenticated host supervisor still exists but its control endpoint is unavailable; refusing a second owner",
      { supervisorPid: descriptor.supervisorPid },
    );
  }
  const appServer = new AppServerClient({
    url: descriptor.url,
    authToken: token,
    requestTimeoutMs: Math.min(config.appServer.requestTimeoutMs, 3_000),
    reconnectLimit: 0,
  });
  let authenticatedOrphan = false;
  try {
    await appServer.connect();
    authenticatedOrphan = true;
  } catch {
    // No authenticated child remains; the signed descriptor itself is stale.
  } finally {
    await appServer.close().catch(() => undefined);
  }
  if (authenticatedOrphan) {
    if (!processAlive(descriptor.appServerPid)) {
      throw new HostBootstrapError(
        "HOST_BUSY",
        "an authenticated orphan app-server is reachable but its recorded process identity cannot be verified",
      );
    }
    try {
      process.kill(descriptor.appServerPid);
    } catch (error) {
      throw new HostBootstrapError(
        (error as NodeJS.ErrnoException).code === "EPERM"
          ? "HOST_PERMISSION_DENIED"
          : "HOST_START_FAILED",
        "failed to terminate the authenticated orphan app-server",
        { appServerPid: descriptor.appServerPid },
        { cause: error },
      );
    }
    const deadline = Date.now() + Math.min(config.appServer.startupTimeoutMs, 10_000);
    while (processAlive(descriptor.appServerPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (processAlive(descriptor.appServerPid)) {
      throw new HostBootstrapError(
        "HOST_START_FAILED",
        "authenticated orphan app-server did not terminate; refusing a second owner",
      );
    }
  }
  await removeHostDescriptorIfOwned(descriptorPath(config), descriptor.hostNonce, token);
  logger.warn(LOG_EVENTS.hostRecovery, {
    startupCorrelationId: correlationId,
    recovery: authenticatedOrphan ? "authenticated-orphan-terminated" : "stale-descriptor-removed",
    appServerPid: descriptor.appServerPid,
    hostNonce: descriptor.hostNonce,
  });
  return authenticatedOrphan ? "authenticated-orphan-terminated" : "stale-descriptor-removed";
}

async function defaultLaunchHost(
  config: BridgeConfig,
  reason: string,
  correlationId: string,
  recoveryResult?: string,
): Promise<number> {
  const compiledEntrypoint = fileURLToPath(new URL("./main.js", import.meta.url));
  let entrypoint = compiledEntrypoint;
  try {
    await access(compiledEntrypoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entrypoint = fileURLToPath(new URL("../../dist/app_server/main.js", import.meta.url));
    try {
      await access(entrypoint);
    } catch (fallbackError) {
      throw new HostBootstrapError(
        "HOST_START_FAILED",
        "compiled host entrypoint is missing; run the production build before source-runtime bootstrap",
        {},
        { cause: fallbackError },
      );
    }
  }
  const child = spawn(process.execPath, [entrypoint], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      BRIDGE_DATA_DIRECTORY: config.dataDirectory,
      BRIDGE_DATABASE_PATH: config.databasePath,
      BRIDGE_LOG_LEVEL: config.logLevel,
      BRIDGE_APP_SERVER_LISTEN_URL: config.appServer.listenUrl,
      BRIDGE_APP_SERVER_TOKEN_PATH: config.appServer.tokenPath,
      BRIDGE_APP_SERVER_STARTUP_TIMEOUT_MS: String(config.appServer.startupTimeoutMs),
      BRIDGE_APP_SERVER_REQUEST_TIMEOUT_MS: String(config.appServer.requestTimeoutMs),
      BRIDGE_APP_SERVER_TURN_TIMEOUT_MS: String(config.appServer.turnTimeoutMs),
      BRIDGE_APP_SERVER_RECONNECT_LIMIT: String(config.appServer.reconnectLimit),
      BRIDGE_ALLOW_REMOTE_APP_SERVER: String(config.appServer.allowRemote),
      BRIDGE_SYNCHRONOUS_WAIT_MS: String(config.messaging.synchronousWaitMs),
      BRIDGE_BUSY_POLL_MS: String(config.messaging.busyPollMs),
      BRIDGE_BUSY_WAIT_MS: String(config.messaging.busyWaitMs),
      BRIDGE_MAX_MESSAGE_BYTES: String(config.messaging.maxMessageBytes),
      BRIDGE_MAX_QUEUE_DEPTH: String(config.messaging.maxQueueDepth),
      BRIDGE_MAX_HOP_COUNT: String(config.messaging.maxHopCount),
      BRIDGE_MAX_CALL_CHAIN_LENGTH: String(config.messaging.maxCallChainLength),
      BRIDGE_MESSAGE_TTL_MS: String(config.messaging.messageTtlMs),
      BRIDGE_MAX_RETRY_ATTEMPTS: String(config.messaging.maxRetryAttempts),
      BRIDGE_RETRY_BASE_MS: String(config.messaging.retryBaseMs),
      BRIDGE_RETRY_MAXIMUM_MS: String(config.messaging.retryMaximumMs),
      BRIDGE_RETRY_JITTER_PERCENT: String(config.messaging.retryJitterPercent),
      BRIDGE_MAX_CONCURRENT_DELIVERIES: String(config.messaging.maxConcurrentDeliveries),
      BRIDGE_MAX_GROUP_FANOUT: String(config.messaging.maxGroupFanout),
      BRIDGE_ACL_DEFAULT_POLICY: config.security.aclDefaultPolicy,
      BRIDGE_BOOTSTRAP_REASON: reason,
      BRIDGE_BOOTSTRAP_CORRELATION_ID: correlationId,
      ...(recoveryResult ? { BRIDGE_LAST_RECOVERY_RESULT: recoveryResult } : {}),
    },
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) throw new Error("detached host launcher did not expose a process ID");
  child.unref();
  return child.pid;
}

export async function ensureHostRunning(
  config: BridgeConfig,
  options: HostBootstrapOptions = {},
): Promise<ManagedHostConnection> {
  const logger = options.logger ?? createLogger(config.logLevel);
  const identity = await resolveRuntimeIdentity(config);
  const probe = options.probeHost ?? probeManagedHost;
  const launch =
    options.launchHost ??
    ((reason, launchCorrelationId, recoveryResult) =>
      defaultLaunchHost(config, reason, launchCorrelationId, recoveryResult));
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const healthy = await probe(config, identity);
  if (healthy) {
    logger.info(LOG_EVENTS.hostReused, {
      startupCorrelationId: correlationId,
      hostPid: healthy.descriptor.supervisorPid,
      hostNonce: healthy.descriptor.hostNonce,
    });
    return { ...healthy, reused: true };
  }

  let lock;
  try {
    lock = await acquireBootstrapLock({
      lockPath: path.join(config.dataDirectory, BOOTSTRAP_LOCK_FILE),
      timeoutMs: config.appServer.startupTimeoutMs,
      staleAfterMs: config.appServer.startupTimeoutMs,
      validateOwner: async () => (await probe(config, identity)) === null,
    });
  } catch (error) {
    throw bootstrapError(error);
  }
  logger.info(LOG_EVENTS.hostLockAcquired, {
    startupCorrelationId: correlationId,
    lockWaitMs: lock.diagnostics.waitedMs,
    launcherPid: process.pid,
  });
  try {
    const afterLock = await probe(config, identity);
    if (afterLock) {
      logger.info(LOG_EVENTS.hostReused, {
        startupCorrelationId: correlationId,
        hostPid: afterLock.descriptor.supervisorPid,
        hostNonce: afterLock.descriptor.hostNonce,
        afterLock: true,
      });
      return { ...afterLock, reused: true };
    }
    const recoveryResult = await recoverStaleManagedHost(config, identity, logger, correlationId);
    const launchedPid = await launch("mcp-or-cli", correlationId, recoveryResult ?? undefined);
    logger.info(LOG_EVENTS.hostLaunchRequested, {
      startupCorrelationId: correlationId,
      launcherPid: process.pid,
      hostPid: launchedPid,
      executable: process.execPath,
      bridgeVersion: BRIDGE_VERSION,
    });
    const deadline = Date.now() + config.appServer.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const ready = await probe(config, identity);
        if (ready) {
          logger.info(LOG_EVENTS.hostReady, {
            startupCorrelationId: correlationId,
            hostPid: ready.descriptor.supervisorPid,
            appServerPid: ready.descriptor.appServerPid,
            hostNonce: ready.descriptor.hostNonce,
            readinessMs: Date.now() - startedAt,
          });
          return { ...ready, reused: false };
        }
      } catch (error) {
        if (error instanceof HostBootstrapError && error.code === "HOST_INCOMPATIBLE") throw error;
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new HostBootstrapError(
      "HOST_START_TIMEOUT",
      `host did not pass authenticated readiness within ${config.appServer.startupTimeoutMs}ms`,
      { launchedPid },
      lastError ? { cause: lastError } : undefined,
    );
  } catch (error) {
    throw bootstrapError(error);
  } finally {
    await lock.release();
  }
}

export async function getHostStatus(config: BridgeConfig): Promise<HostStatus> {
  const identity = await resolveRuntimeIdentity(config);
  try {
    const healthy = await probeManagedHost(config, identity);
    if (healthy) {
      return { state: "ready", descriptor: healthy.descriptor, health: healthy.health };
    }
    const token = await readToken(config);
    if (!token) return { state: "stopped" };
    const read = await readHostDescriptor(descriptorPath(config), token);
    return read.status === "missing" ? { state: "stopped" } : { state: "stale" };
  } catch (error) {
    const typed = bootstrapError(error);
    return {
      state: typed.code === "HOST_INCOMPATIBLE" ? "incompatible" : "failed",
      code: typed.code,
      error: typed.message,
    };
  }
}

export async function stopManagedHost(
  config: BridgeConfig,
  force = false,
): Promise<{ status: "stopped" | "already-stopped" }> {
  const identity = await resolveRuntimeIdentity(config);
  const healthy = await probeManagedHost(config, identity);
  if (!healthy) return { status: "already-stopped" };
  try {
    await requestHostShutdown(healthy.descriptor, healthy.authToken, force);
  } catch (error) {
    throw bootstrapError(error);
  }
  const deadline = Date.now() + config.appServer.startupTimeoutMs;
  while (Date.now() < deadline) {
    if ((await getHostStatus(config)).state === "stopped") return { status: "stopped" };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new HostBootstrapError("HOST_STOP_TIMEOUT", "host did not stop within the deadline");
}

export async function restartManagedHost(
  config: BridgeConfig,
  force = false,
): Promise<ManagedHostConnection> {
  await stopManagedHost(config, force);
  return ensureHostRunning(config);
}

export function isHostDescriptorError(error: unknown): error is HostDescriptorError {
  return error instanceof HostDescriptorError;
}
