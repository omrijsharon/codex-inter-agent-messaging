import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import { BRIDGE_VERSION } from "../version.js";
import { AppServerEventRouter } from "./event_router.js";
import { JsonRpcRequestIdAllocator, SerializedJsonWriter } from "./json_rpc_writer.js";
import { isJsonObject, requiredString, type JsonObject } from "./protocol.js";
import { collectTurn, type CollectedTurn } from "./turn_collector.js";

export class AppServerRequestError extends Error {
  readonly code: string | number;
  readonly data: unknown;
  constructor(code: string | number, message: string, data?: unknown) {
    super(message);
    this.name = "AppServerRequestError";
    this.code = code;
    this.data = data;
  }
}

export type ServerRequestHandler = (method: string, params: JsonObject) => unknown;

export function declineUnattendedServerRequest(method: string): unknown {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    return { decision: "decline" };
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: "denied" };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null, _meta: null };
  }
  throw new Error(`unattended server request denied: ${method}`);
}

export interface AppServerClientOptions {
  readonly url: string;
  readonly authToken: string;
  readonly requestTimeoutMs?: number;
  readonly reconnectLimit?: number;
  readonly serverRequestHandler?: ServerRequestHandler;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

export class AppServerClient extends EventEmitter {
  readonly router = new AppServerEventRouter();
  readonly #options: Required<Pick<AppServerClientOptions, "requestTimeoutMs" | "reconnectLimit">> &
    AppServerClientOptions;
  readonly #ids = new JsonRpcRequestIdAllocator();
  readonly #pending = new Map<number, PendingRequest>();
  #socket: WebSocket | null = null;
  #writer: SerializedJsonWriter | null = null;
  #state: "disconnected" | "connecting" | "handshaking" | "ready" | "closing" = "disconnected";

  constructor(options: AppServerClientOptions) {
    super();
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      reconnectLimit: options.reconnectLimit ?? 5,
      serverRequestHandler: options.serverRequestHandler ?? declineUnattendedServerRequest,
    };
  }

  get ready(): boolean {
    return this.#state === "ready";
  }

  async connect(): Promise<void> {
    if (this.ready) return;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#options.reconnectLimit; attempt += 1) {
      try {
        await this.#connectOnce();
        return;
      } catch (error) {
        lastError = error;
        await this.close();
        if (attempt < this.#options.reconnectLimit)
          await delay(Math.min(100 * 2 ** attempt, 2_000));
      }
    }
    throw lastError;
  }

  async request<T = unknown>(
    method: string,
    params: JsonObject = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!this.#writer || !new Set(["handshaking", "ready"]).has(this.#state)) {
      throw new AppServerRequestError("NOT_CONNECTED", "app-server client is not connected");
    }
    if (options.signal?.aborted) {
      throw new AppServerRequestError(
        "REQUEST_CANCELLED",
        `app-server request cancelled: ${method}`,
      );
    }
    const id = this.#ids.acquire();
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(id);
        reject(
          new AppServerRequestError("REQUEST_TIMEOUT", `app-server request timed out: ${method}`),
        );
      }, timeoutMs);
      const onAbort = options.signal
        ? (): void => {
            this.#settle(id);
            reject(
              new AppServerRequestError(
                "REQUEST_CANCELLED",
                `app-server request cancelled: ${method}`,
              ),
            );
          }
        : undefined;
      if (onAbort) options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(onAbort ? { onAbort } : {}),
      });
    });
    try {
      await this.#writer.write({ id, method, params });
    } catch (error) {
      this.#pending.get(id)?.reject(error as Error);
      this.#settle(id);
    }
    return response;
  }

  async notify(method: string, params?: JsonObject): Promise<void> {
    if (!this.#writer) throw new AppServerRequestError("NOT_CONNECTED", "client is not connected");
    await this.#writer.write(params ? { method, params } : { method });
  }

  listThreads(searchTerm?: string): Promise<JsonObject> {
    return this.request("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      searchTerm: searchTerm ?? null,
    });
  }

  readThread(threadId: string, includeTurns = true): Promise<JsonObject> {
    return this.request("thread/read", { threadId, includeTurns });
  }

  resumeThread(threadId: string): Promise<JsonObject> {
    return this.request("thread/resume", { threadId, excludeTurns: true });
  }

  compactThread(threadId: string): Promise<JsonObject> {
    return this.request("thread/compact/start", { threadId });
  }

  async startTurn(
    threadId: string,
    text: string,
    options: { clientUserMessageId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ turnId: string; completion: Promise<CollectedTurn> }> {
    const checkpoint = this.router.sequence;
    const response = await this.request<JsonObject>(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        approvalPolicy: "never",
        clientUserMessageId: options.clientUserMessageId ?? null,
      },
      options,
    );
    const turn = isJsonObject(response.turn) ? response.turn : null;
    if (!turn)
      throw new AppServerRequestError("INVALID_RESPONSE", "turn/start response has no turn");
    const turnId = requiredString(turn, "id", "turn/start response.turn");
    const collectorOptions = {
      timeoutMs: options.timeoutMs ?? 180_000,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    return {
      turnId,
      completion: collectTurn(this.router, threadId, turnId, checkpoint, collectorOptions),
    };
  }

  async close(): Promise<void> {
    this.#state = "closing";
    const socket = this.#socket;
    this.#socket = null;
    this.#writer = null;
    this.#failPending(new AppServerRequestError("TRANSPORT_CLOSED", "app-server transport closed"));
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1_000);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.close();
      });
    }
    this.#state = "disconnected";
  }

  async #connectOnce(): Promise<void> {
    this.#state = "connecting";
    const socket = new WebSocket(this.#options.url, {
      headers: { Authorization: `Bearer ${this.#options.authToken}` },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
    } catch (error) {
      socket.terminate();
      throw error;
    }
    this.#socket = socket;
    this.#writer = new SerializedJsonWriter(
      (serialized) =>
        new Promise<void>((resolve, reject) =>
          socket.send(serialized, (error) => (error ? reject(error) : resolve())),
        ),
    );
    socket.on("message", (data) => this.#receive(data));
    socket.on("error", (error) => this.emit("transportError", error));
    socket.on("close", () => {
      if (this.#state !== "closing") {
        this.#state = "disconnected";
        this.#failPending(new AppServerRequestError("TRANSPORT_CLOSED", "app-server disconnected"));
        this.emit("disconnect");
      }
    });
    this.#state = "handshaking";
    const initialized = await this.request<JsonObject>("initialize", {
      clientInfo: {
        name: "codex_inter_agent_bridge",
        title: "Codex Inter-Agent Bridge",
        version: BRIDGE_VERSION,
      },
      capabilities: { experimentalApi: true },
    });
    if (
      typeof initialized.userAgent !== "string" ||
      typeof initialized.platformFamily !== "string" ||
      typeof initialized.platformOs !== "string"
    ) {
      throw new AppServerRequestError(
        "CAPABILITY_NEGOTIATION_FAILED",
        "initialize response is missing installed-schema capability fields",
      );
    }
    await this.notify("initialized");
    this.#state = "ready";
  }

  #receive(data: RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(rawText(data)) as unknown;
    } catch {
      this.emit(
        "protocolError",
        new AppServerRequestError("MALFORMED_JSON", "malformed app-server message"),
      );
      return;
    }
    if (!isJsonObject(message)) return;
    const id = typeof message.id === "number" ? message.id : null;
    const method = typeof message.method === "string" ? message.method : null;
    if (id !== null && !method) {
      const pending = this.#pending.get(id);
      if (!pending) return void this.emit("orphanResponse", id);
      if (isJsonObject(message.error)) {
        pending.reject(
          new AppServerRequestError(
            typeof message.error.code === "number" ? message.error.code : "SERVER_ERROR",
            typeof message.error.message === "string"
              ? message.error.message
              : "app-server request failed",
            message.error.data,
          ),
        );
      } else pending.resolve(message.result);
      this.#settle(id);
      return;
    }
    const params = isJsonObject(message.params) ? message.params : {};
    if (id !== null && method) {
      queueMicrotask(() => void this.#handleServerRequest(id, method, params));
      return;
    }
    if (method) this.router.dispatch(method, params);
  }

  async #handleServerRequest(id: number, method: string, params: JsonObject): Promise<void> {
    try {
      if (!this.#options.serverRequestHandler)
        throw new Error(`unsupported server request: ${method}`);
      const result = await this.#options.serverRequestHandler(method, params);
      await this.#writer?.write({ id, result });
    } catch (error) {
      await this.#writer?.write({ id, error: { code: -32601, message: (error as Error).message } });
    }
  }

  #settle(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort)
      pending.signal.removeEventListener("abort", pending.onAbort);
    this.#pending.delete(id);
    this.#ids.release(id);
  }

  #failPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      pending.reject(error);
      this.#settle(id);
    }
  }
}
