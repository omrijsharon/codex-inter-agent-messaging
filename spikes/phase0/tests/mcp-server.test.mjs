import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const phase0Root = path.resolve(here, "..");

function startServer() {
  const child = spawn(process.execPath, [path.join(phase0Root, "mcp-server.mjs")], {
    cwd: phase0Root,
    env: {
      ...process.env,
      PHASE0_AGENT_ID: "inter-agent",
      PHASE0_AGENT_REGISTRY: path.join(phase0Root, "registry.example.json"),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const resolver = responses.get(message.id);
    if (resolver) {
      responses.delete(message.id);
      resolver(message);
    }
  });
  let nextId = 1;
  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve) => {
      responses.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  return { child, request };
}

test("MCP stdio server initializes, lists tools, and runs minimal ask/status operations", async (t) => {
  const { child, request } = startServer();
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  });

  const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.equal(initialized.result.serverInfo.name, "codex-inter-agent-phase0");

  const listed = await request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["list_agents", "ask_agent", "get_request_status"],
  );

  const agents = await request("tools/call", { name: "list_agents", arguments: {} });
  const agentPayload = JSON.parse(agents.result.content[0].text);
  assert.equal(agentPayload.self_agent_id, "inter-agent");
  assert.equal(agentPayload.agents.length, 2);

  const asked = await request("tools/call", {
    name: "ask_agent",
    arguments: { recipient: "missing-agent", message: "hello", wait_ms: 1_000 },
  });
  const askPayload = JSON.parse(asked.result.content[0].text);
  assert.equal(askPayload.status, "failed");
  assert.match(askPayload.error, /unknown recipient/);

  const status = await request("tools/call", {
    name: "get_request_status",
    arguments: { message_id: askPayload.message_id },
  });
  const statusPayload = JSON.parse(status.result.content[0].text);
  assert.equal(statusPayload.status, "failed");
  assert.equal(statusPayload.message_id, askPayload.message_id);
});
