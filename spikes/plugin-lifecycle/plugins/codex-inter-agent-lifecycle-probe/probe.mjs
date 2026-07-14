import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const logPath = process.env.INTER_AGENT_PROBE_LOG ?? path.join(os.tmpdir(), "codex-inter-agent-lifecycle-probe.ndjson");
const relevantEnvironment = Object.fromEntries(
  Object.entries(process.env)
    .filter(([key]) => /CODEX|MCP|AGENT|THREAD|SESSION|TASK|PLUGIN/i.test(key))
    .map(([key, value]) => [key, /TOKEN|KEY|SECRET|PASSWORD/i.test(key) ? "<redacted>" : value]),
);

function record(event, detail = {}) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, pid: process.pid, ppid: process.ppid, cwd: process.cwd(), argv: process.argv.slice(1), environment: relevantEnvironment, ...detail })}\n`,
    "utf8",
  );
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

record("started");
process.once("exit", (code) => record("exit", { code }));
process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  record("request", { method: message.method });
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "codex-inter-agent-lifecycle-probe", version: "0.1.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "probe_identity",
          description: "Return the disposable MCP lifecycle probe process identity.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call" && message.params?.name === "probe_identity") {
    respond(message.id, {
      content: [{ type: "text", text: JSON.stringify({ pid: process.pid, ppid: process.ppid, environment: relevantEnvironment }) }],
    });
    return;
  }
  respond(message.id, {});
});
