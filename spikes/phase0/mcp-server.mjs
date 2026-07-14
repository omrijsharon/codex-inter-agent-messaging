import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import { AppServerClient } from "./app-server-client.mjs";
import { buildPeerEnvelope } from "./envelope.mjs";
import { startWhenRecipientIdle } from "./recipient-queue.mjs";

const serverInfo = { name: "codex-inter-agent-phase0", version: "0.0.0-phase0" };
const requests = new Map();

const toolDefinitions = [
  {
    name: "list_agents",
    description: "List registered Phase 0 agents that can receive inter-agent requests.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ask_agent",
    description: "Send an on-demand request to a registered Codex agent and wait for its final reply.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string" },
        message: { type: "string" },
        conversation_id: { type: ["string", "null"] },
        wait_ms: { type: "integer", minimum: 1, maximum: 300000 },
      },
      required: ["recipient", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "get_request_status",
    description: "Retrieve a Phase 0 request by message ID after ask_agent returned pending.",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
      additionalProperties: false,
    },
  },
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message, details = {}) {
  process.stderr.write(`${JSON.stringify({ level: "info", message, ...details })}\n`);
}

async function loadRegistry() {
  const path = process.env.PHASE0_AGENT_REGISTRY;
  if (!path) throw new Error("PHASE0_AGENT_REGISTRY is required");
  return JSON.parse(await readFile(path, "utf8"));
}

function callerAgentId() {
  const value = process.env.PHASE0_AGENT_ID;
  if (!value) throw new Error("PHASE0_AGENT_ID is required and must be set by operator-controlled MCP configuration");
  return value;
}

async function deliver({ recipient, message, conversationId, messageId }) {
  const registry = await loadRegistry();
  const senderAgentId = callerAgentId();
  const sender = registry.agents?.[senderAgentId];
  const target = registry.agents?.[recipient];
  if (!sender) throw new Error(`unregistered sender agent: ${senderAgentId}`);
  if (!target) throw new Error(`unknown recipient agent: ${recipient}`);
  if (target.status !== "active" || target.accepts_messages === false) {
    throw new Error(`recipient is unavailable: ${recipient}`);
  }

  const client = new AppServerClient({
    url: process.env.PHASE0_APP_SERVER_URL,
    authToken: process.env.PHASE0_APP_SERVER_TOKEN,
  });
  client.on("stderr", (chunk) => log("app_server_stderr", { chunk: String(chunk).trim() }));
  try {
    await client.connect();
    const envelope = buildPeerEnvelope({
      messageId,
      conversationId,
      senderAgentId,
      recipientAgentId: recipient,
      body: message,
    });
    const queued = await startWhenRecipientIdle(
      client,
      target.thread_id,
      () =>
        client.startTurnAndCollect(target.thread_id, envelope, {
          clientUserMessageId: messageId,
          timeoutMs: 180_000,
        }),
      {
        pollMs: Number.parseInt(process.env.PHASE0_BUSY_POLL_MS ?? "100", 10),
        maxWaitMs: Number.parseInt(process.env.PHASE0_BUSY_WAIT_MS ?? "120000", 10),
      },
    );
    const result = queued.result;
    if (result.turn?.status !== "completed" || !result.finalMessage) {
      return {
        status: result.turn?.status ?? "failed",
        message_id: messageId,
        conversation_id: conversationId,
        from_agent: recipient,
        to_agent: senderAgentId,
        target_thread_id: target.thread_id,
        target_turn_id: result.turnId,
        queued_ms: queued.queuedMs,
        waited_for_recipient: queued.observedBusy,
        error: result.turn?.error ?? "recipient produced no final agent message",
      };
    }
    return {
      status: "completed",
      message_id: messageId,
      conversation_id: conversationId,
      from_agent: recipient,
      to_agent: senderAgentId,
      target_thread_id: target.thread_id,
      target_turn_id: result.turnId,
      queued_ms: queued.queuedMs,
      waited_for_recipient: queued.observedBusy,
      reply: result.finalMessage.text,
    };
  } finally {
    await client.close();
  }
}

async function callTool(name, args = {}) {
  if (name === "list_agents") {
    const registry = await loadRegistry();
    return {
      self_agent_id: callerAgentId(),
      agents: Object.entries(registry.agents ?? {}).map(([agentId, agent]) => ({
        agent_id: agentId,
        display_name: agent.display_name,
        available: agent.status === "active" && agent.accepts_messages !== false,
      })),
    };
  }

  if (name === "ask_agent") {
    const messageId = `msg_${randomUUID()}`;
    const conversationId = args.conversation_id || `conv_${randomUUID()}`;
    const record = { status: "running", sender: callerAgentId(), promise: null, result: null };
    record.promise = deliver({
      recipient: args.recipient,
      message: args.message,
      conversationId,
      messageId,
    }).then(
      (result) => {
        record.status = result.status;
        record.result = result;
        return result;
      },
      (error) => {
        record.status = "failed";
        record.result = { status: "failed", message_id: messageId, error: error.message, error_code: error.code ?? null };
        return record.result;
      },
    );
    requests.set(messageId, record);

    const waitMs = Number.isInteger(args.wait_ms) ? args.wait_ms : 120_000;
    const outcome = await Promise.race([
      record.promise,
      new Promise((resolve) => setTimeout(() => resolve(null), waitMs)),
    ]);
    return outcome ?? { status: "pending", message_id: messageId, conversation_id: conversationId };
  }

  if (name === "get_request_status") {
    const record = requests.get(args.message_id);
    if (!record || record.sender !== callerAgentId()) {
      return { status: "unknown", message_id: args.message_id };
    }
    return record.result ?? { status: record.status, message_id: args.message_id };
  }

  throw new Error(`unknown tool: ${name}`);
}

async function handle(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo,
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: toolDefinitions };
  if (message.method === "tools/call") {
    const result = await callTool(message.params?.name, message.params?.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.status === "failed" };
  }
  if (message.method?.startsWith("notifications/")) return undefined;
  throw new Error(`unsupported MCP method: ${message.method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } });
    return;
  }

  try {
    const result = await handle(message);
    if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    if (message.id !== undefined) {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } });
    }
  }
});

log("phase0_mcp_started", { server: serverInfo.name, pid: process.pid });
