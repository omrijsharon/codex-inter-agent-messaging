import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";
import WebSocket from "ws";

const DEFAULT_TIMEOUT_MS = 30_000;

export class AppServerClient extends EventEmitter {
  constructor({
    command = "codex",
    args = ["app-server"],
    cwd = process.env.PHASE0_APP_SERVER_CWD,
    url = process.env.PHASE0_APP_SERVER_URL,
    authToken = process.env.PHASE0_APP_SERVER_TOKEN,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.url = url;
    this.authToken = authToken;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.socket = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.serverRequestHandler = null;
  }

  async connect() {
    if (this.child || this.socket) return;

    if (this.url) {
      const headers = this.authToken ? { Authorization: `Bearer ${this.authToken}` } : undefined;
      this.socket = new WebSocket(this.url, { headers });
      await new Promise((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (error) => {
          cleanup();
          this.socket = null;
          reject(error);
        };
        const cleanup = () => {
          this.socket?.off("open", onOpen);
          this.socket?.off("error", onError);
        };
        this.socket.once("open", onOpen);
        this.socket.once("error", onError);
      });
      this.socket.on("message", (data) => this.#handleLine(String(data)));
      this.socket.on("error", (error) => this.#failAll(error));
      this.socket.on("close", (code, reason) => {
        const error = new Error(`app-server websocket closed (code=${code}, reason=${String(reason)})`);
        error.code = "APP_SERVER_EXIT";
        this.#failAll(error);
        this.emit("exit", { code, signal: null });
        this.socket = null;
      });
    } else {
      this.child = spawn(this.command, this.args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      this.child.stderr.setEncoding("utf8");
      this.child.stderr.on("data", (chunk) => this.emit("stderr", chunk));
      this.child.once("error", (error) => this.#failAll(error));
      this.child.once("exit", (code, signal) => {
        const error = new Error(`app-server exited (code=${code}, signal=${signal})`);
        error.code = "APP_SERVER_EXIT";
        this.#failAll(error);
        this.emit("exit", { code, signal });
        this.child = null;
      });

      const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => this.#handleLine(line));
    }

    await this.request("initialize", {
      clientInfo: {
        name: "codex_inter_agent_phase0",
        title: "Codex Inter-Agent Phase 0",
        version: "0.0.0-phase0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.child && !this.socket) throw new Error("app-server is not connected");
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`app-server request timed out: ${method}`);
        error.code = "APP_SERVER_TIMEOUT";
        reject(error);
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ id, method, params });
    });
  }

  notify(method, params) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.#write(message);
  }

  async listThreads({ searchTerm, limit = 100 } = {}) {
    return this.request("thread/list", { limit, sortKey: "updated_at", searchTerm: searchTerm ?? null });
  }

  startThread(options = {}) {
    return this.request("thread/start", options);
  }

  searchThreads(searchTerm, { limit = 100 } = {}) {
    return this.request("thread/search", { searchTerm, limit, sortKey: "updated_at" });
  }

  readThread(threadId, includeTurns = true) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  getConversationSummary(threadId) {
    return this.request("getConversationSummary", { conversationId: threadId });
  }

  resumeThread(threadId) {
    return this.request("thread/resume", { threadId, excludeTurns: true });
  }

  forkThread(threadId, options = {}) {
    return this.request("thread/fork", {
      threadId,
      excludeTurns: true,
      ...options,
    });
  }

  injectItems(threadId, items) {
    return this.request("thread/inject_items", { threadId, items });
  }

  listMcpServerStatus(threadId) {
    return this.request("mcpServerStatus/list", { threadId, detail: "full" });
  }

  callMcpTool(threadId, server, tool, args = {}, timeoutMs = 300_000) {
    return this.request(
      "mcpServer/tool/call",
      {
        threadId,
        server,
        tool,
        arguments: args,
      },
      timeoutMs,
    );
  }

  async compactThread(threadId, { timeoutMs = 120_000 } = {}) {
    const notificationStart = this.notifications.length;
    await this.request("thread/compact/start", { threadId }, timeoutMs);

    const completed = await this.waitForNotification(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.threadId === threadId,
      { timeoutMs, startIndex: notificationStart },
    );

    return {
      threadId,
      turn: completed.params.turn,
    };
  }

  async compactThreadAndCaptureRaw(threadId, { timeoutMs = 120_000 } = {}) {
    const notificationStart = this.notifications.length;
    await this.request("thread/compact/start", { threadId }, timeoutMs);

    const raw = await this.waitForNotification(
      (message) =>
        message.method === "rawResponseItem/completed" &&
        message.params?.threadId === threadId,
      { timeoutMs, startIndex: notificationStart },
    );
    const completed = await this.waitForNotification(
      (message) => message.method === "turn/completed" && message.params?.threadId === threadId,
      { timeoutMs, startIndex: notificationStart },
    );

    return { item: raw.params.item, turn: completed.params.turn };
  }

  async startTurnAndCollect(
    threadId,
    text,
    { clientUserMessageId, timeoutMs = 120_000, model, effort } = {},
  ) {
    const notificationStart = this.notifications.length;
    const response = await this.request(
      "turn/start",
      {
        threadId,
        clientUserMessageId: clientUserMessageId ?? null,
        input: [{ type: "text", text, text_elements: [] }],
        approvalPolicy: "never",
        model: model ?? null,
        effort: effort ?? null,
      },
      timeoutMs,
    );

    const turnId = response?.turn?.id;
    if (!turnId) throw new Error("turn/start response did not include turn.id");

    const completed = await this.waitForNotification(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.threadId === threadId &&
        message.params?.turn?.id === turnId,
      { timeoutMs, startIndex: notificationStart },
    );

    const relevant = this.notifications.slice(notificationStart).filter(
      (message) => message.params?.threadId === threadId,
    );
    const agentMessages = relevant
      .filter(
        (message) =>
          message.method === "item/completed" &&
          message.params?.turnId === turnId &&
          message.params?.item?.type === "agentMessage",
      )
      .map((message) => message.params.item);
    const finalMessage =
      [...agentMessages].reverse().find((item) => item.phase === "final_answer") ??
      agentMessages.at(-1) ??
      null;

    return {
      threadId,
      turnId,
      turn: completed.params.turn,
      agentMessages,
      finalMessage,
    };
  }

  waitForNotification(predicate, { timeoutMs = this.requestTimeoutMs, startIndex = 0 } = {}) {
    for (let index = startIndex; index < this.notifications.length; index += 1) {
      const message = this.notifications[index];
      if (predicate(message)) return Promise.resolve(message);
    }

    return new Promise((resolve, reject) => {
      const onNotification = (message) => {
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      };
      const timer = setTimeout(() => {
        cleanup();
        const error = new Error("timed out waiting for app-server notification");
        error.code = "APP_SERVER_NOTIFICATION_TIMEOUT";
        reject(error);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("notification", onNotification);
      };
      this.on("notification", onNotification);
    });
  }

  async close() {
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      await new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
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

    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (child.exitCode === null) child.kill();
    this.child = null;
  }

  #write(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (!this.child?.stdin?.writable) throw new Error("app-server transport is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      error.message = `invalid app-server JSON line: ${error.message}`;
      this.emit("protocolError", error, line);
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit("orphanResponse", message);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? `app-server request failed: ${pending.method}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.#handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.notifications.push(message);
      this.emit("notification", message);
      return;
    }

    this.emit("protocolError", new Error("unrecognized app-server message"), line);
  }

  async #handleServerRequest(message) {
    try {
      if (!this.serverRequestHandler) {
        throw new Error(`no Phase 0 handler for server request ${message.method}`);
      }
      const result = await this.serverRequestHandler(message);
      this.#write({ id: message.id, result });
    } catch (error) {
      this.#write({
        id: message.id,
        error: { code: -32601, message: error.message },
      });
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
