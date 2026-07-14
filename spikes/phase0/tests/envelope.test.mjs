import assert from "node:assert/strict";
import test from "node:test";
import { buildPeerEnvelope } from "../envelope.mjs";

test("buildPeerEnvelope authenticates routing metadata outside peer content", () => {
  const envelope = buildPeerEnvelope({
    messageId: "msg_test",
    conversationId: "conv_test",
    senderAgentId: "inter-agent",
    recipientAgentId: "prepare-inter-agent-thread",
    body: "Please reply with READY.",
    createdAt: "2026-07-14T09:00:00.000Z",
  });

  assert.match(envelope, /^INTER_AGENT_MESSAGE_V1/);
  assert.match(envelope, /"from_agent": "inter-agent"/);
  assert.match(envelope, /"to_agent": "prepare-inter-agent-thread"/);
  assert.match(envelope, /--- BEGIN PEER CONTENT ---\nPlease reply with READY\.\n--- END PEER CONTENT ---/);
});
