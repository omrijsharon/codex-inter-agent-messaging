import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BridgeConfig } from "../config/index.js";
import { LOG_EVENTS, type Logger } from "../logging/logger.js";

export interface SharedAppServerConnection {
  readonly url: string;
  readonly authToken: string;
}

export interface SharedAppServerHostOptions {
  readonly appServer: BridgeConfig["appServer"];
  readonly logger: Logger;
  readonly command?: string;
  readonly workingDirectory?: string;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error("failed to reserve a loopback app-server port");
  return port;
}

async function ensureCapabilityToken(tokenPath: string): Promise<string> {
  await mkdir(path.dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  try {
    const handle = await open(tokenPath, "wx", 0o600);
    try {
      await handle.writeFile(token, "utf8");
    } finally {
      await handle.close();
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (existing.length < 32) throw new Error("existing app-server capability token is invalid");
    return existing;
  }
}

async function concreteListenUrl(configured: string): Promise<string> {
  const url = new URL(configured);
  if (url.port === "0") url.port = String(await reserveLoopbackPort());
  return url.toString().replace(/\/$/, "");
}

export class SharedAppServerHost {
  readonly #options: SharedAppServerHostOptions;
  #child: ChildProcess | null = null;
  #connection: SharedAppServerConnection | null = null;
  #stderr = "";

  constructor(options: SharedAppServerHostOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  get connection(): SharedAppServerConnection {
    if (!this.#connection || !this.running) throw new Error("shared app-server is not running");
    return this.#connection;
  }

  async start(): Promise<SharedAppServerConnection> {
    if (this.running) return this.connection;
    const url = await concreteListenUrl(this.#options.appServer.listenUrl);
    const authToken = await ensureCapabilityToken(this.#options.appServer.tokenPath);
    this.#stderr = "";
    const child = spawn(
      this.#options.command ?? "codex",
      [
        "app-server",
        "--listen",
        url,
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
        this.#options.appServer.tokenPath,
      ],
      {
        cwd: this.#options.workingDirectory,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    this.#child = child;
    this.#connection = { url, authToken };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8192);
    });

    try {
      await this.#waitUntilReady(url, child);
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.#options.logger.info(LOG_EVENTS.appServerStarted, { url, pid: child.pid });
    return this.connection;
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    this.#connection = null;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      delay(5_000).then(() => undefined),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    this.#options.logger.info(LOG_EVENTS.appServerStopped, { pid: child.pid });
  }

  async #waitUntilReady(url: string, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.#options.appServer.startupTimeoutMs;
    const readyUrl = new URL(url);
    readyUrl.protocol = readyUrl.protocol === "wss:" ? "https:" : "http:";
    readyUrl.pathname = "/readyz";
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`app-server exited before readiness: ${this.#stderr.trim()}`);
      }
      try {
        const response = await fetch(readyUrl, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return;
      } catch {
        // Startup is asynchronous; retry until the configured deadline.
      }
      await delay(100);
    }
    throw new Error(`app-server readiness timed out: ${this.#stderr.trim()}`);
  }
}
