import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMessagingMcpServer } from "../../src/messaging/mcp_server.js";
import type { AsyncMessagingService } from "../../src/messaging/async_service.js";
import type { GroupMessagingService } from "../../src/messaging/group_service.js";
import type { MessagingService } from "../../src/messaging/service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("production MCP server", () => {
  it("publishes strict caller-bound tools and structured results", async () => {
    const service = {
      listAgents: () => [
        {
          agentId: "recipient",
          displayName: "Recipient",
          generation: 1,
          status: "active",
          acceptsMessages: true,
          workspace: "[REDACTED]",
          activeThreadId: "thread_recipient",
          createdAt: "now",
          updatedAt: "now",
        },
      ],
      ask: () =>
        Promise.resolve({
          status: "completed",
          messageId: "msg_1",
          conversationId: "conv_1",
          fromAgent: "recipient",
          reply: "ANSWER",
          targetThreadId: "thread_recipient",
          targetTurnId: "turn_1",
        }),
      status: (messageId: string) => ({ status: "unknown", messageId }),
    } as unknown as MessagingService;
    const asyncService = {
      send: () => ({
        status: "queued",
        messageId: "msg_async",
        conversationId: "conv_async",
        recipient: "recipient",
      }),
      readInbox: () => ({ messages: [] }),
      reply: () => ({
        status: "queued",
        messageId: "msg_reply",
        conversationId: "conv_async",
        recipient: "recipient",
      }),
      status: (messageId: string) => ({ status: "unknown", messageId }),
      acknowledge: () => {
        throw new Error("not found");
      },
    } as unknown as AsyncMessagingService;
    const groupService = {
      listGroups: () => [],
      send: () => ({
        groupMessageId: "gmsg_1",
        groupId: "reviewers",
        conversationId: "conv_group",
        senderAgentId: "sender",
        deliveries: [],
        summary: {},
      }),
      status: () => {
        throw new Error("not found");
      },
      retry: () => {
        throw new Error("not found");
      },
      gather: () => ({ groupMessageId: "gmsg_1", synthesizingAgent: "sender", replies: [] }),
    } as unknown as GroupMessagingService;
    const server = createMessagingMcpServer(service, asyncService, groupService);
    const client = new Client({ name: "mcp-integration-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    cleanup.push(async () => server.close());
    cleanup.push(async () => client.close());
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_agents",
      "ask_agent",
      "get_request_status",
      "send_message",
      "read_inbox",
      "reply_to_message",
      "get_message_status",
      "acknowledge_message",
      "list_groups",
      "send_group_message",
      "get_group_message_status",
      "retry_group_message",
      "gather_group_replies",
    ]);
    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    expect(listed.structuredContent).toMatchObject({ agents: [{ agent_id: "recipient" }] });
    const asked = await client.callTool({
      name: "ask_agent",
      arguments: { recipient: "recipient", message: "question" },
    });
    expect(asked.structuredContent).toMatchObject({ status: "completed", reply: "ANSWER" });
    const status = await client.callTool({
      name: "get_request_status",
      arguments: { message_id: "msg_unknown" },
    });
    expect(status.structuredContent).toEqual({ status: "unknown", message_id: "msg_unknown" });
    const sent = await client.callTool({
      name: "send_message",
      arguments: { recipient: "recipient", message: "later" },
    });
    expect(sent.structuredContent).toMatchObject({ status: "queued", message_id: "msg_async" });
    const inbox = await client.callTool({ name: "read_inbox", arguments: {} });
    expect(inbox.structuredContent).toEqual({ messages: [] });
    const groups = await client.callTool({ name: "list_groups", arguments: {} });
    expect(groups.structuredContent).toEqual({ groups: [] });
    const groupSent = await client.callTool({
      name: "send_group_message",
      arguments: { group_id: "reviewers", message: "review" },
    });
    expect(groupSent.structuredContent).toMatchObject({ group_message_id: "gmsg_1" });

    for (const [field, value] of Object.entries({
      sender: "attacker",
      from_agent: "attacker",
      sender_agent_id: "attacker",
      threadId: "thread_attacker",
      target_thread_id: "thread_attacker",
      callChain: ["attacker"],
      hopCount: 0,
      authenticated_metadata: { sender: "attacker" },
    })) {
      const spoofed = await client.callTool({
        name: "ask_agent",
        arguments: { recipient: "recipient", message: "question", [field]: value },
      });
      expect(spoofed.isError, field).toBe(true);
    }
  });
});
