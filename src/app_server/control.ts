import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { HostDescriptor } from "./descriptor.js";
import { LOG_EVENTS, type Logger } from "../logging/logger.js";

const CLIENT_TTL_MS = 30_000;
const MAX_BODY_BYTES = 16 * 1024;

export interface HostControlHealth extends HostDescriptor {
  readonly status: "ready" | "stopping";
  readonly uptimeMs: number;
  readonly activeMcpClients: number;
  readonly activeDeliveries: { readonly messages: number; readonly leases: number };
  readonly bootstrapMode: string;
  readonly lastRecoveryResult: string | null;
}

export interface OwnerCapability {
  readonly bridgeVersion: string;
  readonly protocolVersion: string;
  readonly ownerMode: "bridge-managed";
  readonly installationId: string;
  readonly databaseId: string;
  readonly ownershipGeneration: string;
  readonly hostNonce: string;
  readonly transport: "websocket";
  readonly capabilityTokenMode: "capability-token";
  readonly appServerUserAgent: string;
}

function ownerCapability(descriptor: HostDescriptor): OwnerCapability {
  return {
    bridgeVersion: descriptor.bridgeVersion,
    protocolVersion: descriptor.protocolVersion,
    ownerMode: descriptor.ownerMode,
    installationId: descriptor.installationId,
    databaseId: descriptor.databaseId,
    ownershipGeneration: descriptor.ownershipGeneration,
    hostNonce: descriptor.hostNonce,
    transport: descriptor.transport,
    capabilityTokenMode: descriptor.capabilityTokenMode,
    appServerUserAgent: descriptor.appServerUserAgent,
  };
}

export interface HostControlServerOptions {
  readonly authToken: string;
  readonly getDescriptor: () => HostDescriptor;
  readonly getActiveDeliveries: () => { readonly messages: number; readonly leases: number };
  readonly onShutdown: (reason: string) => void;
  readonly bootstrapMode: string;
  readonly lastRecoveryResult?: string | null;
  readonly logger?: Logger;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const actual = request.headers.authorization ?? "";
  const expected = `Bearer ${token}`;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array);
    total += value.length;
    if (total > MAX_BODY_BYTES) throw new Error("control request body is too large");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("control request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

export class HostControlServer {
  readonly #options: HostControlServerOptions;
  readonly #clients = new Map<string, { leaseToken: string; lastSeen: number }>();
  #server: Server | null = null;
  #startedAt = Date.now();
  #state: "ready" | "stopping" = "ready";

  constructor(options: HostControlServerOptions) {
    this.#options = options;
  }

  async start(): Promise<string> {
    if (this.#server) throw new Error("host control server is already running");
    this.#startedAt = Date.now();
    const server = createServer((request, response) => void this.#handle(request, response));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("invalid control listener address");
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  #pruneClients(): void {
    const threshold = Date.now() - CLIENT_TTL_MS;
    for (const [clientId, lease] of this.#clients) {
      if (lease.lastSeen < threshold) this.#clients.delete(clientId);
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorized(request, this.#options.authToken)) {
      json(response, 401, { code: "HOST_AUTH_FAILED", error: "authentication required" });
      return;
    }
    this.#pruneClients();
    try {
      if (request.method === "GET" && request.url === "/health") {
        json(response, 200, {
          ...this.#options.getDescriptor(),
          status: this.#state,
          uptimeMs: Date.now() - this.#startedAt,
          activeMcpClients: this.#clients.size,
          activeDeliveries: this.#options.getActiveDeliveries(),
          bootstrapMode: this.#options.bootstrapMode,
          lastRecoveryResult: this.#options.lastRecoveryResult ?? null,
        } satisfies HostControlHealth);
        return;
      }
      if (request.method === "POST" && request.url?.startsWith("/clients/")) {
        const requestBody = await body(request);
        const clientId = requestBody.clientId;
        if (typeof clientId !== "string" || clientId.length < 8 || clientId.length > 256) {
          json(response, 400, { code: "INVALID_CLIENT_ID" });
          return;
        }
        if (request.url === "/clients/register") {
          const expectedCapability = ownerCapability(this.#options.getDescriptor());
          if (JSON.stringify(requestBody.ownerCapability) !== JSON.stringify(expectedCapability)) {
            json(response, 409, {
              code: "OWNER_CAPABILITY_MISMATCH",
              error: "client and host owner capabilities do not match",
            });
            return;
          }
          const leaseToken = randomUUID();
          this.#clients.set(clientId, { leaseToken, lastSeen: Date.now() });
          this.#options.logger?.info(LOG_EVENTS.hostClientRegistered, {
            clientId,
            activeMcpClients: this.#clients.size,
          });
          json(response, 200, {
            status: "ok",
            activeMcpClients: this.#clients.size,
            leaseToken,
            ownerCapability: expectedCapability,
          });
          return;
        }
        const leaseToken = requestBody.leaseToken;
        const lease = this.#clients.get(clientId);
        if (typeof leaseToken !== "string" || lease?.leaseToken !== leaseToken) {
          json(response, 403, { code: "HOST_CLIENT_LEASE_INVALID" });
          return;
        }
        if (request.url === "/clients/heartbeat") {
          this.#clients.set(clientId, { ...lease, lastSeen: Date.now() });
        } else if (request.url === "/clients/unregister") {
          this.#clients.delete(clientId);
          this.#options.logger?.info(LOG_EVENTS.hostClientUnregistered, {
            clientId,
            activeMcpClients: this.#clients.size,
          });
        } else {
          json(response, 404, { code: "NOT_FOUND" });
          return;
        }
        json(response, 200, { status: "ok", activeMcpClients: this.#clients.size });
        return;
      }
      if (request.method === "POST" && request.url === "/shutdown") {
        const requestBody = await body(request);
        const force = requestBody.force === true;
        if (requestBody.expectedHostNonce !== this.#options.getDescriptor().hostNonce) {
          json(response, 409, {
            code: "HOST_IDENTITY_MISMATCH",
            error: "host identity changed; refresh status before shutdown",
          });
          return;
        }
        const activeDeliveries = this.#options.getActiveDeliveries();
        if (!force && (activeDeliveries.messages > 0 || activeDeliveries.leases > 0)) {
          this.#options.logger?.warn(LOG_EVENTS.hostShutdownRejected, activeDeliveries);
          json(response, 409, {
            code: "HOST_ACTIVE_DELIVERIES",
            error: "host has active deliveries; retry with operator --force",
          });
          return;
        }
        this.#state = "stopping";
        this.#options.logger?.info(LOG_EVENTS.hostShutdownRequested, {
          force,
          activeMcpClients: this.#clients.size,
        });
        json(response, 202, { status: "stopping" });
        queueMicrotask(() => this.#options.onShutdown(force ? "operator-force" : "operator"));
        return;
      }
      json(response, 404, { code: "NOT_FOUND" });
    } catch (error) {
      json(response, 400, {
        code: "INVALID_CONTROL_REQUEST",
        error: error instanceof Error ? error.message : "invalid request",
      });
    }
  }
}

async function controlRequest<T>(
  controlUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 3_000,
): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const value = (await response.json()) as T & { code?: string; error?: string };
  if (!response.ok) {
    const error = new Error(value.error ?? `host control request failed (${response.status})`);
    Object.assign(error, { code: value.code ?? "HOST_CONTROL_FAILED", status: response.status });
    throw error;
  }
  return value;
}

export function probeHostControl(
  descriptor: HostDescriptor,
  token: string,
  timeoutMs?: number,
): Promise<HostControlHealth> {
  return controlRequest(descriptor.controlUrl, token, "/health", {}, timeoutMs);
}

export function requestHostShutdown(
  descriptor: HostDescriptor,
  token: string,
  force: boolean,
): Promise<{ status: "stopping" }> {
  return controlRequest(descriptor.controlUrl, token, "/shutdown", {
    method: "POST",
    body: JSON.stringify({ force, expectedHostNonce: descriptor.hostNonce }),
  });
}

export interface HostClientLease {
  close(): Promise<void>;
}

export async function registerHostClient(
  descriptor: HostDescriptor,
  token: string,
  clientId: string,
  observedAppServerUserAgent: string,
): Promise<HostClientLease> {
  if (observedAppServerUserAgent !== descriptor.appServerUserAgent) {
    throw Object.assign(new Error("MCP app-server identity does not match the managed owner"), {
      code: "OWNER_CAPABILITY_MISMATCH",
    });
  }
  const expectedCapability = ownerCapability(descriptor);
  let leaseToken = "";
  const send = (action: "register" | "heartbeat" | "unregister") =>
    controlRequest(descriptor.controlUrl, token, `/clients/${action}`, {
      method: "POST",
      body: JSON.stringify({
        clientId,
        ...(action === "register" ? { ownerCapability: expectedCapability } : {}),
        ...(leaseToken ? { leaseToken } : {}),
      }),
    });
  const registration = (await send("register")) as {
    leaseToken: string;
    ownerCapability: OwnerCapability;
  };
  if (JSON.stringify(registration.ownerCapability) !== JSON.stringify(expectedCapability)) {
    throw Object.assign(new Error("host returned a different owner capability"), {
      code: "OWNER_CAPABILITY_MISMATCH",
    });
  }
  leaseToken = registration.leaseToken;
  const timer = setInterval(() => void send("heartbeat").catch(() => undefined), 10_000);
  timer.unref();
  return {
    async close() {
      clearInterval(timer);
      await Promise.race([send("unregister"), delay(1_000)]).catch(() => undefined);
    },
  };
}
