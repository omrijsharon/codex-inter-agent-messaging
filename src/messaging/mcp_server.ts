#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AppServerClient } from "../app_server/client.js";
import { ensureHostRunning } from "../app_server/bootstrap.js";
import { registerHostClient } from "../app_server/control.js";
import { loadConfig } from "../config/index.js";
import { isMainModule } from "../entrypoint.js";
import { createLogger } from "../logging/logger.js";
import { BridgeDatabase } from "../store/database.js";
import {
  AclRepository,
  AgentRepository,
  MessageRepository,
  RecipientLeaseRepository,
} from "../store/repositories.js";
import type { AskAgentResult } from "./service.js";
import { MessagingError, MessagingService } from "./service.js";
import { AsyncMessagingService } from "./async_service.js";
import { registerAsyncMessagingTools } from "./async_mcp.js";
import { DeliveryScheduler } from "./scheduler.js";
import { GroupMessagingService } from "./group_service.js";
import { registerGroupMessagingTools } from "./group_mcp.js";
import { GroupRepository } from "../store/groups.js";
import { BRIDGE_VERSION } from "../version.js";

function toolResult(structuredContent: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError,
  };
}

export function createMessagingMcpServer(
  service: MessagingService,
  asyncService: AsyncMessagingService,
  groupService: GroupMessagingService,
): McpServer {
  const server = new McpServer(
    { name: "codex-inter-agent-messaging", version: BRIDGE_VERSION },
    {
      instructions:
        "Use these tools only on explicit demand. Select registered recipients with list_agents, avoid request cycles, and recover pending work with status/inbox tools. Sender identity is trusted process configuration and cannot be overridden by tool arguments.",
    },
  );
  server.registerTool(
    "list_agents",
    {
      description: "List registered agents available for an on-demand peer request.",
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({
        agents: z.array(
          z.strictObject({
            agent_id: z.string(),
            display_name: z.string(),
            generation: z.number().int(),
            available: z.boolean(),
          }),
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => {
      const agents = service.listAgents().map((agent) => ({
        agent_id: agent.agentId,
        display_name: agent.displayName,
        generation: agent.generation,
        available: true,
      }));
      return toolResult({ agents });
    },
  );
  server.registerTool(
    "ask_agent",
    {
      description: "Send an on-demand request to a registered agent and wait for its final reply.",
      inputSchema: z.strictObject({
        recipient: z.string().min(1),
        message: z.string().min(1),
        conversation_id: z.string().min(1).optional(),
        parent_message_id: z.string().min(1).optional(),
        idempotency_key: z.string().min(1).max(256).optional(),
        wait_ms: z.number().int().min(1).max(300_000).optional(),
      }),
      outputSchema: z.strictObject({
        status: z.enum(["completed", "pending", "failed"]),
        message_id: z.string(),
        conversation_id: z.string(),
        from_agent: z.string().optional(),
        reply: z.string().optional(),
        target_thread_id: z.string().optional(),
        target_turn_id: z.string().optional(),
        error_code: z.string().optional(),
        error: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      try {
        const result = await service.ask(
          {
            recipient: input.recipient,
            message: input.message,
            ...(input.conversation_id ? { conversationId: input.conversation_id } : {}),
            ...(input.parent_message_id ? { parentMessageId: input.parent_message_id } : {}),
            ...(input.idempotency_key ? { idempotencyKey: input.idempotency_key } : {}),
            ...(input.wait_ms ? { waitMs: input.wait_ms } : {}),
          },
          extra.signal,
        );
        return toolResult(publicResult(result));
      } catch (error) {
        return toolResult(
          {
            status: "failed",
            message_id: `msg_rejected_${randomUUID()}`,
            conversation_id: input.conversation_id ?? `conv_rejected_${randomUUID()}`,
            error_code: error instanceof MessagingError ? error.code : "REQUEST_REJECTED",
            error: error instanceof MessagingError ? error.message : "request rejected",
          },
          true,
        );
      }
    },
  );
  server.registerTool(
    "get_request_status",
    {
      description: "Retrieve a previously accepted request owned by the calling agent.",
      inputSchema: z.strictObject({ message_id: z.string().min(1) }),
      outputSchema: z.strictObject({
        status: z.enum(["completed", "pending", "failed", "unknown"]),
        message_id: z.string(),
        conversation_id: z.string().optional(),
        from_agent: z.string().optional(),
        reply: z.string().optional(),
        target_thread_id: z.string().optional(),
        target_turn_id: z.string().optional(),
        error_code: z.string().optional(),
        error: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => toolResult(publicResult(service.status(input.message_id))),
  );
  registerAsyncMessagingTools(server, asyncService);
  registerGroupMessagingTools(server, groupService);
  return server;
}

function publicResult(
  result: AskAgentResult | { status: "unknown"; messageId: string },
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );
}

async function main(): Promise<void> {
  const senderAgentId = process.env.BRIDGE_AGENT_ID;
  if (!senderAgentId)
    throw new Error("BRIDGE_AGENT_ID is required in trusted MCP process configuration");
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  await mkdir(path.dirname(config.databasePath), { recursive: true });
  const store = new BridgeDatabase(config.databasePath);
  const acl = new AclRepository(store);
  const unboundAgents = new AgentRepository(store);
  const messages = new MessageRepository(store);
  const leases = new RecipientLeaseRepository(store);
  let caller;
  try {
    caller = unboundAgents.get(senderAgentId);
  } catch (error) {
    store.close();
    throw error;
  }
  if (caller.status !== "active" || !caller.acceptsMessages) {
    store.close();
    throw new Error(`trusted caller identity is not active: ${senderAgentId}`);
  }
  const managedHost = await ensureHostRunning(config, { logger });
  const agents = new AgentRepository(store, {
    ownerMode: managedHost.descriptor.ownerMode,
    installationId: managedHost.descriptor.installationId,
    databaseId: managedHost.descriptor.databaseId,
    protocolVersion: managedHost.descriptor.protocolVersion,
  });
  if (!agents.isOwnedByCurrentHost(agents.get(senderAgentId))) {
    store.close();
    throw new Error(`trusted caller identity has no authoritative owner binding: ${senderAgentId}`);
  }
  const instanceId = `mcp_${randomUUID()}`;
  const appServer = new AppServerClient({
    url: managedHost.url,
    authToken: managedHost.authToken,
    requestTimeoutMs: config.appServer.requestTimeoutMs,
    reconnectLimit: config.appServer.reconnectLimit,
  });
  let hostLease;
  try {
    await appServer.connect();
    hostLease = await registerHostClient(
      managedHost.descriptor,
      managedHost.authToken,
      instanceId,
      appServer.serverIdentity?.userAgent ?? "",
    );
  } catch (error) {
    await appServer.close().catch(() => undefined);
    store.close();
    throw error;
  }
  const scheduler = new DeliveryScheduler({
    instanceId,
    config: { ...config.messaging, turnTimeoutMs: config.appServer.turnTimeoutMs },
    appServer,
    agents,
    messages,
    leases,
    logger,
  });
  const authorize = (from: string, to: string): boolean =>
    acl.isAllowed(from, to, config.security.aclDefaultPolicy === "allow");
  const service = new MessagingService({
    senderAgentId,
    instanceId,
    config: { ...config.messaging, turnTimeoutMs: config.appServer.turnTimeoutMs },
    appServer,
    agents,
    messages,
    leases,
    authorize,
    scheduler,
  });
  const asyncService = new AsyncMessagingService({
    senderAgentId,
    config: config.messaging,
    agents,
    messages,
    scheduler,
    authorize,
  });
  const groupService = new GroupMessagingService({
    senderAgentId,
    config: config.messaging,
    agents,
    groups: new GroupRepository(store),
    scheduler,
    authorize,
  });
  service.start();
  const server = createMessagingMcpServer(service, asyncService, groupService);
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    await hostLease.close();
    await appServer.close();
    store.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
  process.stdin.once("close", () => void shutdown());
  await server.connect(new StdioServerTransport());
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "MCP server failed"}\n`);
    process.exitCode = 1;
  });
}
