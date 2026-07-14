import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "plugins", "codex-inter-agent-messaging");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-plugin-smoke-"));
const installed = path.join(temporaryRoot, "Installed Plugin Ω with spaces");
const dataDirectory = path.join(temporaryRoot, "bridge data Ω");
const environment = {
  ...process.env,
  BRIDGE_AGENT_ID: "plugin-smoke",
  BRIDGE_DATA_DIRECTORY: dataDirectory,
  BRIDGE_LOG_LEVEL: "error",
};

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("child process exit timed out")), timeoutMs),
    ),
  ]);
}

async function stopHost() {
  const child = spawn(
    process.execPath,
    [path.join(installed, "runtime", "dist", "cli", "main.js"), "host", "stop"],
    { cwd: installed, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const code = await waitForExit(child);
  if (code !== 0) throw new Error(`plugin host stop failed: ${stderr}`);
}

let operationError;
let cleanupError;
try {
  await cp(source, installed, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  const { BridgeDatabase } = await import(
    pathToFileURL(path.join(root, "dist", "store", "database.js")).href
  );
  const { AgentRepository } = await import(
    pathToFileURL(path.join(root, "dist", "store", "repositories.js")).href
  );
  const { loadConfig } = await import(
    pathToFileURL(path.join(root, "dist", "config", "index.js")).href
  );
  const { resolveRuntimeIdentity } = await import(
    pathToFileURL(path.join(root, "dist", "app_server", "identity.js")).href
  );
  const config = loadConfig({ BRIDGE_DATA_DIRECTORY: dataDirectory }, temporaryRoot);
  const identity = await resolveRuntimeIdentity(config);
  const store = new BridgeDatabase(config.databasePath);
  new AgentRepository(store, {
    ownerMode: "bridge-managed",
    installationId: identity.installationId,
    databaseId: identity.databaseId,
    protocolVersion: "2",
  }).register({
    agentId: "plugin-smoke",
    displayName: "Plugin Smoke",
    threadId: "00000000-0000-4000-8000-000000000001",
    workspace: temporaryRoot,
  });
  store.close();
  const mcp = JSON.parse(await readFile(path.join(installed, ".mcp.json"), "utf8"));
  const definition = mcp.mcpServers["codex-inter-agent-messaging"];
  const child = spawn(definition.command, definition.args, {
    cwd: installed,
    env: environment,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  let nextId = 1;
  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}; stderr=${stderr}`));
      }, 60_000);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "plugin-smoke", version: "0.4.0" },
  });
  if (initialized.result?.serverInfo?.name !== "codex-inter-agent-messaging") {
    throw new Error("installed plugin MCP returned the wrong server identity");
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await request("tools/list");
  const toolNames = listed.result?.tools?.map((tool) => tool.name) ?? [];
  for (const required of [
    "list_agents",
    "ask_agent",
    "get_request_status",
    "send_message",
    "read_inbox",
    "reply_to_message",
    "send_group_message",
  ]) {
    if (!toolNames.includes(required))
      throw new Error(`installed plugin is missing tool ${required}`);
  }
  const called = await request("tools/call", { name: "list_agents", arguments: {} });
  if (called.result?.isError === true || !Array.isArray(called.result?.structuredContent?.agents)) {
    throw new Error("installed plugin list_agents call failed");
  }
  child.stdin.end();
  await waitForExit(child).catch(() => child.kill());
  await stopHost();

  const unknownData = path.join(temporaryRoot, "unknown caller data Ω");
  await mkdir(unknownData, { recursive: true });
  const unknown = spawn(definition.command, definition.args, {
    cwd: installed,
    env: {
      ...environment,
      BRIDGE_AGENT_ID: "unknown-caller",
      BRIDGE_DATA_DIRECTORY: unknownData,
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let unknownStderr = "";
  unknown.stderr.setEncoding("utf8").on("data", (chunk) => (unknownStderr += chunk));
  unknown.stdin.end();
  const unknownCode = await waitForExit(unknown);
  if (unknownCode === 0 || !unknownStderr.includes("unknown agent")) {
    throw new Error(`installed plugin did not reject an unknown trusted caller: ${unknownStderr}`);
  }
  const unknownHostStarted = await access(path.join(unknownData, "connection.json"))
    .then(() => true)
    .catch(() => false);
  if (unknownHostStarted) throw new Error("unknown caller started a bridge host");
  process.stdout.write(
    `${JSON.stringify({ status: "passed", installedPath: "<temporary path with spaces and Unicode>", tools: toolNames.length, unknownCallerRejected: true })}\n`,
  );
} catch (error) {
  operationError = error;
} finally {
  await stopHost().catch(() => undefined);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 9) cleanupError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

if (operationError) throw operationError;
if (cleanupError) throw cleanupError;
