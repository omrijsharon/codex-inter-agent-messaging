import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./app-server-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(here, "registry.json");
const sourceThreadId = "019f5f8d-f4f6-79c1-8ce3-4d767b906934";
const targetThreadId = "019f6082-fd66-7da2-aa9f-b6461c2c486d";

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("failed to reserve a loopback port");
  return port;
}

async function waitForReady(port, child, stderr) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`shared app-server exited before readiness: ${stderr.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) return;
    } catch {
      // Listener startup is asynchronous.
    }
    await delay(100);
  }
  throw new Error(`shared app-server did not become ready: ${stderr.join("")}`);
}

async function startMcpInstance({ url, token }) {
  const child = spawn(process.execPath, [path.join(here, "mcp-server.mjs")], {
    cwd: here,
    env: {
      ...process.env,
      PHASE0_AGENT_ID: "inter-agent",
      PHASE0_AGENT_REGISTRY: registryPath,
      PHASE0_APP_SERVER_URL: url,
      PHASE0_APP_SERVER_TOKEN: token,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  const stderr = [];
  let nextId = 1;
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter.resolve(message);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  child.once("exit", (code, signal) => {
    const error = new Error(`MCP instance exited (code=${code}, signal=${signal}): ${stderr.join("")}`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "phase0-shared-ownership-probe", version: "0.0.0-phase0" },
  });
  assert.equal(initialized.result?.serverInfo?.name, "codex-inter-agent-phase0");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return {
    child,
    request,
    stderr,
    async close() {
      child.stdin.end();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(1_000),
      ]);
      if (child.exitCode === null) child.kill();
    },
  };
}

function toolPayload(response) {
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`MCP response did not contain JSON text: ${JSON.stringify(response)}`);
  return JSON.parse(text);
}

function ask(instance, message, conversationId) {
  return instance.request("tools/call", {
    name: "ask_agent",
    arguments: {
      recipient: "prepare-inter-agent-thread",
      message,
      conversation_id: conversationId,
      wait_ms: 180_000,
    },
  }).then(toolPayload);
}

function countMessageTurns(thread, messageId) {
  return (thread.turns ?? []).filter((turn) =>
    turn.items?.some((item) => item.type === "userMessage" && item.clientId === messageId),
  ).length;
}

function messageTurnIndex(thread, messageId) {
  return (thread.turns ?? []).findIndex((turn) =>
    turn.items?.some((item) => item.type === "userMessage" && item.clientId === messageId),
  );
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-phase0-shared-"));
const token = randomBytes(32).toString("base64url");
const tokenPath = path.join(tempRoot, "token.txt");
await writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 });
const port = await reservePort();
const url = `ws://127.0.0.1:${port}`;
const serverStderr = [];
const appServer = spawn(
  "codex",
  [
    "app-server",
    "--listen",
    url,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    tokenPath,
  ],
  { cwd: tempRoot, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
);
appServer.stderr.setEncoding("utf8");
appServer.stderr.on("data", (chunk) => serverStderr.push(String(chunk)));

let first;
let second;
let observer;
try {
  await waitForReady(port, appServer, serverStderr);
  observer = new AppServerClient({ url, authToken: token, requestTimeoutMs: 240_000 });
  await observer.connect();
  await observer.resumeThread(sourceThreadId);
  first = await startMcpInstance({ url, token });
  second = await startMcpInstance({ url, token });

  const firstPromise = ask(
    first,
    "Run exactly one PowerShell command: Start-Sleep -Seconds 10. Then reply exactly SHARED_A_DONE.",
    "phase0-shared-owner-a",
  );

  let activeStatus = null;
  const activeDeadline = Date.now() + 60_000;
  while (Date.now() < activeDeadline) {
    const resumed = await observer.resumeThread(targetThreadId);
    activeStatus = resumed.thread?.status?.type ?? null;
    if (activeStatus === "active") break;
    await delay(100);
  }
  assert.equal(activeStatus, "active", "shared owner never exposed the active target turn");

  let firstSettledAt = null;
  let secondSettledAt = null;
  const observedFirst = firstPromise.then((result) => {
    firstSettledAt = Date.now();
    return result;
  });
  const secondPromise = ask(
    second,
    "Reply exactly SHARED_B_DONE and do not call tools.",
    "phase0-shared-owner-b-queued",
  ).then((result) => {
    secondSettledAt = Date.now();
    return result;
  });

  const earlySecond = await Promise.race([
    secondPromise.then(() => "settled"),
    delay(500).then(() => "waiting"),
  ]);
  assert.equal(earlySecond, "waiting", "second delivery did not remain queued while recipient was active");

  const firstResult = await observedFirst;
  assert.equal(firstResult.status, "completed");
  assert.equal(firstResult.reply, "SHARED_A_DONE");

  const secondResult = await secondPromise;
  assert.equal(secondResult.status, "completed");
  assert.equal(secondResult.reply, "SHARED_B_DONE");
  assert.equal(secondResult.waited_for_recipient, true);
  assert.ok(secondResult.queued_ms >= 500, `expected meaningful queue wait, got ${secondResult.queued_ms}ms`);
  assert.ok(secondSettledAt >= firstSettledAt, "queued delivery settled before the active delivery");

  const target = await observer.readThread(targetThreadId, true);
  const firstTurns = countMessageTurns(target.thread, firstResult.message_id);
  const secondTurns = countMessageTurns(target.thread, secondResult.message_id);
  const firstTurnIndex = messageTurnIndex(target.thread, firstResult.message_id);
  const secondTurnIndex = messageTurnIndex(target.thread, secondResult.message_id);
  assert.deepEqual({ firstTurns, secondTurns }, { firstTurns: 1, secondTurns: 1 });
  assert.ok(firstTurnIndex >= 0 && secondTurnIndex > firstTurnIndex, "queued turn is not ordered after active turn");

  process.stdout.write(
    `${JSON.stringify(
      {
        transport: "authenticated-loopback-websocket",
        activeStatus,
        firstResult,
        secondResult,
        settlementOrder: { firstSettledAt, secondSettledAt },
        transcriptCounts: { firstTurns, secondTurns },
        transcriptOrder: { firstTurnIndex, secondTurnIndex },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await first?.close();
  await second?.close();
  await observer?.close();
  if (appServer.exitCode === null) {
    appServer.kill();
    await Promise.race([
      new Promise((resolve) => appServer.once("exit", resolve)),
      delay(5_000),
    ]);
  }
  let cleanupError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      cleanupError = null;
      break;
    } catch (error) {
      cleanupError = error;
      if (!["EBUSY", "EPERM"].includes(error.code)) throw error;
      await delay(100);
    }
  }
  if (cleanupError) throw cleanupError;
}
