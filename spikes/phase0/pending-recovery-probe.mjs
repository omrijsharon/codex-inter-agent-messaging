import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerClient } from "./app-server-client.mjs";

const sourceThreadId = "019f5f8d-f4f6-79c1-8ce3-4d767b906934";
const targetThreadId = "019f6082-fd66-7da2-aa9f-b6461c2c486d";
const server = "agent_messaging_phase0";

function payload(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP result did not contain text JSON");
  return JSON.parse(text);
}

function countMessageTurns(thread, messageId) {
  return (thread?.turns ?? []).filter((turn) =>
    turn.items?.some((item) => item.type === "userMessage" && item.clientId === messageId),
  ).length;
}

const client = new AppServerClient({ requestTimeoutMs: 300_000 });
client.on("stderr", (chunk) => process.stderr.write(chunk));

try {
  await client.connect();
  await client.resumeThread(sourceThreadId);

  const startedAt = Date.now();
  const pending = payload(
    await client.callMcpTool(sourceThreadId, server, "ask_agent", {
      recipient: "prepare-inter-agent-thread",
      message: "Reply exactly PHASE0_PENDING_OK and do not call tools.",
      conversation_id: "phase0-pending-recovery",
      wait_ms: 1,
    }),
  );
  const pendingReturnedAfterMs = Date.now() - startedAt;
  assert.equal(pending.status, "pending");
  assert.match(pending.message_id, /^msg_/);

  let terminal = null;
  let polls = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    polls += 1;
    const current = payload(
      await client.callMcpTool(sourceThreadId, server, "get_request_status", {
        message_id: pending.message_id,
      }),
    );
    if (!["running", "pending"].includes(current.status)) {
      terminal = current;
      break;
    }
    await delay(200);
  }

  assert.ok(terminal, "request did not reach a terminal state before the deadline");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.message_id, pending.message_id);
  assert.equal(terminal.target_thread_id, targetThreadId);
  assert.equal(terminal.reply, "PHASE0_PENDING_OK");

  const target = await client.readThread(targetThreadId, true);
  const matchingRecipientTurns = countMessageTurns(target.thread, pending.message_id);
  assert.equal(matchingRecipientTurns, 1, "pending recovery created a duplicate recipient turn");

  process.stdout.write(
    `${JSON.stringify(
      {
        pendingReturnedAfterMs,
        polls,
        pending,
        terminal,
        matchingRecipientTurns,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close();
}
