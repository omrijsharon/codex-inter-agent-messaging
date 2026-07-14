#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AppServerClient } from "../app_server/client.js";
import { resolveSharedOwnerUrl } from "../app_server/runtime.js";
import { loadConfig } from "../config/index.js";
import { BridgeDatabase } from "../store/database.js";
import { AclRepository, AgentRepository } from "../store/repositories.js";
import { GroupRepository } from "../store/groups.js";
import { BRIDGE_VERSION } from "../version.js";
import { AdminService, AppServerThreadVerifier } from "./admin_service.js";

const VERSION = BRIDGE_VERSION;

export interface CliRuntime {
  readonly service: AdminService;
  close(): Promise<void>;
}

type RuntimeFactory = () => Promise<CliRuntime>;

function usage(): string {
  return [
    `codex-inter-agent ${BRIDGE_VERSION}`,
    "",
    "Usage:",
    "  codex-inter-agent list",
    "  codex-inter-agent show <agent-id>",
    "  codex-inter-agent register --agent-id <id> --display-name <name> --thread-id <id> --workspace <path>",
    "  codex-inter-agent pause|resume|disable|supersede <agent-id>",
    "  codex-inter-agent replace <agent-id> --thread-id <id> --workspace <path> --generation <n> --confirm-agent-id <id>",
    "  codex-inter-agent discover <thread-title-search>",
    "  codex-inter-agent acl list",
    "  codex-inter-agent acl allow|deny|remove <sender-agent-id> <recipient-agent-id>",
    "  codex-inter-agent health",
    "  codex-inter-agent backup --output <new-sqlite-path>",
    "  codex-inter-agent group create --group-id <id> --display-name <name> --owner-agent-id <id>",
    "  codex-inter-agent group show|pause|resume|delete <group-id>",
    "  codex-inter-agent group add|remove <group-id> <agent-id>",
    "  codex-inter-agent config",
  ].join("\n");
}

function flags(arguments_: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`invalid option: ${key ?? ""}`);
    result.set(key.slice(2), value);
  }
  return result;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function createRuntime(): Promise<CliRuntime> {
  const config = loadConfig();
  const appServerUrl = await resolveSharedOwnerUrl(config);
  await mkdir(path.dirname(config.databasePath), { recursive: true });
  const store = new BridgeDatabase(config.databasePath);
  const authToken = (await readFile(config.appServer.tokenPath, "utf8")).trim();
  const client = new AppServerClient({
    url: appServerUrl,
    authToken,
    requestTimeoutMs: config.appServer.requestTimeoutMs,
    reconnectLimit: config.appServer.reconnectLimit,
  });
  try {
    await client.connect();
  } catch (error) {
    store.close();
    throw error;
  }
  return {
    service: new AdminService(
      new AgentRepository(store),
      new AppServerThreadVerifier(client),
      new AclRepository(store),
      new GroupRepository(store),
    ),
    async close() {
      await client.close();
      store.close();
    },
  };
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runCli(
  arguments_: readonly string[],
  runtimeFactory: RuntimeFactory = createRuntime,
): Promise<number> {
  const command = arguments_[0] ?? "--help";
  if (command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "config") {
    const config = loadConfig();
    output({
      ...config,
      databasePath: "[REDACTED]",
      appServer: { ...config.appServer, tokenPath: "[REDACTED]" },
    });
    return 0;
  }

  const runtime = await runtimeFactory();
  try {
    if (command === "health") output(await runtime.service.health());
    else if (command === "backup") {
      const options = flags(arguments_.slice(1));
      output(await runtime.service.backup(required(options, "output")));
    } else if (command === "list") output(runtime.service.list());
    else if (command === "show")
      output(runtime.service.show(required(new Map([["id", arguments_[1] ?? ""]]), "id")));
    else if (command === "register") {
      const options = flags(arguments_.slice(1));
      output(
        await runtime.service.register({
          agentId: required(options, "agent-id"),
          displayName: required(options, "display-name"),
          threadId: required(options, "thread-id"),
          workspace: required(options, "workspace"),
        }),
      );
    } else if (["pause", "resume", "disable", "supersede"].includes(command)) {
      const agentId = arguments_[1];
      if (!agentId) throw new Error(`${command} requires an agent ID`);
      const statuses = {
        pause: "paused",
        resume: "active",
        disable: "disabled",
        supersede: "superseded",
      } as const;
      output(runtime.service.setStatus(agentId, statuses[command as keyof typeof statuses]));
    } else if (command === "replace") {
      const agentId = arguments_[1];
      if (!agentId) throw new Error("replace requires an agent ID");
      const options = flags(arguments_.slice(2));
      const generation = Number(required(options, "generation"));
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new Error("invalid --generation");
      output(
        await runtime.service.replace({
          agentId,
          threadId: required(options, "thread-id"),
          workspace: required(options, "workspace"),
          expectedGeneration: generation,
          confirmation: required(options, "confirm-agent-id"),
        }),
      );
    } else if (command === "discover") {
      const search = arguments_[1];
      if (!search) throw new Error("discover requires a title search");
      output(await runtime.service.discover(search));
    } else if (command === "acl") {
      const action = arguments_[1];
      if (action === "list") output(runtime.service.listAcl());
      else {
        const sender = arguments_[2];
        const recipient = arguments_[3];
        if (!sender || !recipient)
          throw new Error(`acl ${action ?? ""} requires sender and recipient IDs`);
        if (action === "allow" || action === "deny") {
          output(runtime.service.setAcl(sender, recipient, action === "allow"));
        } else if (action === "remove") output(runtime.service.removeAcl(sender, recipient));
        else throw new Error(`unknown acl action: ${action ?? ""}`);
      }
    } else if (command === "group") {
      const action = arguments_[1];
      if (action === "create") {
        const options = flags(arguments_.slice(2));
        output(
          runtime.service.createGroup(
            required(options, "group-id"),
            required(options, "display-name"),
            required(options, "owner-agent-id"),
          ),
        );
      } else {
        const groupId = arguments_[2];
        if (!groupId) throw new Error(`group ${action ?? ""} requires a group ID`);
        if (action === "show") output(runtime.service.showGroup(groupId));
        else if (action === "add" || action === "remove") {
          const agentId = arguments_[3];
          if (!agentId) throw new Error(`group ${action} requires an agent ID`);
          output(
            action === "add"
              ? runtime.service.addGroupMember(groupId, agentId)
              : runtime.service.removeGroupMember(groupId, agentId),
          );
        } else if (action === "pause" || action === "resume" || action === "delete") {
          output(
            runtime.service.setGroupStatus(
              groupId,
              action === "pause" ? "paused" : action === "resume" ? "active" : "deleted",
            ),
          );
        } else throw new Error(`unknown group action: ${action ?? ""}`);
      }
    } else throw new Error(`unknown command: ${command}`);
    return 0;
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "command failed"}\n`);
    process.exitCode = 2;
  });
}
