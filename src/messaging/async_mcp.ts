import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AsyncMessagingService } from "./async_service.js";
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
      messageId: `msg_rejected_${randomUUID()}`,
      conversationId: `conv_rejected_${randomUUID()}`,
      recipient: "unknown",
      errorCode: error instanceof MessagingError ? error.code : "REQUEST_REJECTED",
      error: error instanceof MessagingError ? error.message : "request rejected",
    },
    true,
  );
}

const statusSchema = z.strictObject({
  status: z.enum(["queued", "running", "delivered", "failed", "expired", "dead_letter"]),
  message_id: z.string(),
  conversation_id: z.string(),
  recipient: z.string(),
  target_thread_id: z.string().optional(),
  target_turn_id: z.string().optional(),
  error_code: z.string().optional(),
  error: z.string().optional(),
});

const inboxItemSchema = z.strictObject({
  message_id: z.string(),
  conversation_id: z.string(),
  parent_message_id: z.string().optional(),
  from_agent: z.string(),
  kind: z.enum(["request", "reply", "notice"]),
  message: z.string(),
  created_at: z.string(),
  delivered_at: z.string(),
  read: z.boolean(),
  acknowledged: z.boolean(),
});

export function registerAsyncMessagingTools(
  server: McpServer,
  service: AsyncMessagingService,
): void {
  server.registerTool(
    "send_message",
    {
      description: "Persist an explicit asynchronous message and return immediately.",
      inputSchema: z.strictObject({
        recipient: z.string().min(1),
        message: z.string().min(1),
        kind: z.enum(["request", "notice"]).optional(),
        conversation_id: z.string().min(1).optional(),
        parent_message_id: z.string().min(1).optional(),
        idempotency_key: z.string().min(1).max(256).optional(),
      }),
      outputSchema: statusSchema,
      annotations: WRITE,
    },
    (input) => {
      try {
        return result(
          service.send({
            recipient: input.recipient,
            message: input.message,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.conversation_id ? { conversationId: input.conversation_id } : {}),
            ...(input.parent_message_id ? { parentMessageId: input.parent_message_id } : {}),
            ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {}),
          }),
        );
      } catch (error) {
        return rejected(error);
      }
    },
  );
  server.registerTool(
    "read_inbox",
    {
      description: "Read delivered asynchronous messages for the authenticated recipient.",
      inputSchema: z.strictObject({
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        mark_read: z.boolean().optional(),
      }),
      outputSchema: z.strictObject({
        messages: z.array(inboxItemSchema),
        next_cursor: z.string().optional(),
      }),
      annotations: WRITE,
    },
    (input) => {
      try {
        return result(
          service.readInbox({
            ...(input.cursor ? { cursor: input.cursor } : {}),
            ...(input.limit ? { limit: input.limit } : {}),
            ...(input.mark_read !== undefined ? { markRead: input.mark_read } : {}),
          }),
        );
      } catch (error) {
        return rejected(error);
      }
    },
  );
  server.registerTool(
    "reply_to_message",
    {
      description: "Create an explicit asynchronous reply to an inbox message.",
      inputSchema: z.strictObject({
        message_id: z.string().min(1),
        message: z.string().min(1),
        idempotency_key: z.string().min(1).max(256).optional(),
      }),
      outputSchema: statusSchema,
      annotations: WRITE,
    },
    (input) => {
      try {
        return result(
          service.reply({
            messageId: input.message_id,
            message: input.message,
            ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {}),
          }),
        );
      } catch (error) {
        return rejected(error);
      }
    },
  );
  server.registerTool(
    "get_message_status",
    {
      description: "Get asynchronous delivery status for an authorized participant.",
      inputSchema: z.strictObject({ message_id: z.string().min(1) }),
      outputSchema: z.union([
        z.strictObject({ status: z.literal("unknown"), message_id: z.string() }),
        statusSchema,
      ]),
      annotations: READ_ONLY,
    },
    (input) => result(service.status(input.message_id)),
  );
  server.registerTool(
    "acknowledge_message",
    {
      description: "Explicitly acknowledge one delivered inbox message.",
      inputSchema: z.strictObject({ message_id: z.string().min(1) }),
      outputSchema: inboxItemSchema,
      annotations: WRITE,
    },
    (input) => {
      try {
        return result(service.acknowledge(input.message_id));
      } catch (error) {
        return rejected(error);
      }
    },
  );
}
