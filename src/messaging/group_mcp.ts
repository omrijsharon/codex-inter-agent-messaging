import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GroupMessagingService } from "./group_service.js";
import { MessagingError } from "./service.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function snake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snake);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      snake(child),
    ]),
  );
}

function result(value: unknown, isError = false) {
  const structuredContent = snake(value) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError,
  };
}

function rejected(error: unknown) {
  return result(
    {
      status: "failed",
      groupMessageId: `gmsg_rejected_${randomUUID()}`,
      errorCode: error instanceof MessagingError ? error.code : "REQUEST_REJECTED",
      error: error instanceof MessagingError ? error.message : "request rejected",
    },
    true,
  );
}

const groupStatusSchema = z.strictObject({
  group_message_id: z.string(),
  group_id: z.string(),
  conversation_id: z.string(),
  sender_agent_id: z.string(),
  deliveries: z.array(
    z.strictObject({
      recipient: z.string(),
      message_id: z.string(),
      status: z.enum(["queued", "running", "delivered", "failed", "expired", "dead_letter"]),
      error_code: z.string().optional(),
    }),
  ),
  summary: z.record(z.string(), z.number().int()),
});

export function registerGroupMessagingTools(
  server: McpServer,
  service: GroupMessagingService,
): void {
  server.registerTool(
    "list_groups",
    {
      description: "List groups visible to the authenticated agent.",
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({
        groups: z.array(
          z.strictObject({
            group_id: z.string(),
            display_name: z.string(),
            role: z.string(),
            member_count: z.number().int(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    () => result({ groups: service.listGroups() }),
  );
  server.registerTool(
    "send_group_message",
    {
      description: "Create one immutable group message and independent member deliveries.",
      inputSchema: z.strictObject({
        group_id: z.string().min(1),
        message: z.string().min(1),
        conversation_id: z.string().min(1).optional(),
        idempotency_key: z.string().min(1).max(256).optional(),
      }),
      outputSchema: groupStatusSchema,
      annotations: WRITE,
    },
    (input) => {
      try {
        return result(
          service.send({
            groupId: input.group_id,
            message: input.message,
            ...(input.conversation_id ? { conversationId: input.conversation_id } : {}),
            ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {}),
          }),
        );
      } catch (error) {
        return rejected(error);
      }
    },
  );
  server.registerTool(
    "get_group_message_status",
    {
      description: "Inspect independent per-recipient outcomes for a visible group message.",
      inputSchema: z.strictObject({ group_message_id: z.string().min(1) }),
      outputSchema: groupStatusSchema,
      annotations: READ_ONLY,
    },
    (input) => {
      try {
        return result(service.status(input.group_message_id));
      } catch (error) {
        return rejected(error);
      }
    },
  );
  server.registerTool(
    "retry_group_message",
    {
      description: "Retry only failed/dead-letter recipients without redelivering successes.",
      inputSchema: z.strictObject({
        group_message_id: z.string().min(1),
        recipients: z.array(z.string().min(1)).max(100).optional(),
      }),
      outputSchema: groupStatusSchema,
      annotations: WRITE,
    },
    (input) => {
      try {
        return result(service.retry(input.group_message_id, input.recipients));
      } catch (error) {
        return rejected(error);
      }
    },
  );
  server.registerTool(
    "gather_group_replies",
    {
      description: "Gather only explicit visible replies and name the synthesizing agent.",
      inputSchema: z.strictObject({ group_message_id: z.string().min(1) }),
      outputSchema: z.strictObject({
        group_message_id: z.string(),
        synthesizing_agent: z.string(),
        replies: z.array(
          z.strictObject({ from_agent: z.string(), message_id: z.string(), reply: z.string() }),
        ),
      }),
      annotations: READ_ONLY,
    },
    (input) => {
      try {
        return result(service.gather(input.group_message_id));
      } catch (error) {
        return rejected(error);
      }
    },
  );
}
