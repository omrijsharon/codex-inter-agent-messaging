import type { LogLevel } from "../config/index.js";

export const LOG_EVENTS = {
  bridgeStarting: "bridge.starting",
  bridgeReady: "bridge.ready",
  bridgeStopped: "bridge.stopped",
  configLoaded: "config.loaded",
  appServerConnected: "app_server.connected",
  appServerDisconnected: "app_server.disconnected",
  appServerStarted: "app_server.started",
  appServerStopped: "app_server.stopped",
  hostLockAcquired: "host.lock_acquired",
  hostLaunchRequested: "host.launch_requested",
  hostReady: "host.ready",
  hostReused: "host.reused",
  hostRecovery: "host.recovery",
  hostIncompatible: "host.incompatible",
  hostShutdownRequested: "host.shutdown_requested",
  hostClientRegistered: "host.client_registered",
  hostClientUnregistered: "host.client_unregistered",
  hostShutdownRejected: "host.shutdown_rejected",
  messageQueued: "message.queued",
  messageDispatched: "message.dispatched",
  messageCompleted: "message.completed",
  messageFailed: "message.failed",
} as const;

export type LogEvent = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];
export type LogFields = Readonly<Record<string, unknown>>;
export type LogSink = (line: string) => void;

export interface Logger {
  log(level: LogLevel, event: LogEvent, fields?: LogFields): void;
  debug(event: LogEvent, fields?: LogFields): void;
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, fields?: LogFields): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(authorization|token|secret|password|peer.?content|message.?body|reply|workspace|cwd|path$)/i;
const SENSITIVE_VALUE =
  /(bearer\s+[a-z0-9._~+/-]+=*|(?:password|token|secret)\s*[:=]\s*\S+|[a-z]:[\\/](?:users|documents|repos|appdata)[\\/][^\s"']+)/i;

export function redactSensitiveText(value: string): string {
  return SENSITIVE_VALUE.test(value) ? REDACTED : value;
}

function redact(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, key, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      redact(childValue, childKey, seen),
    ]),
  );
}

export function redactLogFields(fields: LogFields): LogFields {
  return redact(fields) as LogFields;
}

export function createLogger(
  minimumLevel: LogLevel = "info",
  sink: LogSink = (line) => process.stderr.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  const log = (level: LogLevel, event: LogEvent, fields: LogFields = {}): void => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minimumLevel]) return;
    sink(
      JSON.stringify({
        timestamp: now().toISOString(),
        level,
        event,
        ...redactLogFields(fields),
      }),
    );
  };

  return {
    log,
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}
