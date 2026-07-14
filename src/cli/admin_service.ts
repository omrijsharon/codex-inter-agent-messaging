import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { isJsonObject } from "../app_server/protocol.js";
import type { AppServerClient } from "../app_server/client.js";
import type { AgentRecord, AgentStatus } from "../store/models.js";
import type { AclRepository, AclRuleRecord, AgentRepository } from "../store/repositories.js";
import type { GroupRepository, GroupStatus } from "../store/groups.js";

export interface VerifiedThread {
  readonly threadId: string;
  readonly status: string;
}

export interface ThreadVerifier {
  verify(threadId: string): Promise<VerifiedThread>;
  discover(search: string): Promise<readonly { threadId: string; title: string | null }[]>;
  health?(): Promise<boolean>;
}

export class AppServerThreadVerifier implements ThreadVerifier {
  constructor(readonly client: AppServerClient) {}

  async verify(threadId: string): Promise<VerifiedThread> {
    const read = await this.client.readThread(threadId, false);
    const readThread = isJsonObject(read.thread) ? read.thread : null;
    if (readThread?.id !== threadId)
      throw new Error("app-server did not return the requested thread");
    const resumed = await this.client.resumeThread(threadId);
    const thread = isJsonObject(resumed.thread) ? resumed.thread : null;
    const status = isJsonObject(thread?.status) ? thread.status.type : null;
    if (thread?.id !== threadId || typeof status !== "string") {
      throw new Error("app-server could not verify the live thread status");
    }
    return { threadId, status };
  }

  async discover(search: string): Promise<readonly { threadId: string; title: string | null }[]> {
    const result = await this.client.listThreads(search);
    if (!Array.isArray(result.data)) return [];
    return result.data.flatMap((value) => {
      if (!isJsonObject(value) || typeof value.id !== "string") return [];
      return [{ threadId: value.id, title: typeof value.name === "string" ? value.name : null }];
    });
  }

  async health(): Promise<boolean> {
    const result = await this.client.listThreads();
    return Array.isArray(result.data);
  }
}

export class AdminService {
  constructor(
    readonly agents: AgentRepository,
    readonly verifier: ThreadVerifier,
    readonly acl?: AclRepository,
    readonly groups?: GroupRepository,
  ) {}

  async register(input: {
    agentId: string;
    displayName: string;
    threadId: string;
    workspace: string;
  }): Promise<AgentRecord> {
    await this.verifier.verify(input.threadId);
    return this.agents.register(input);
  }

  list(): AgentRecord[] {
    return this.agents.list();
  }

  show(agentId: string): AgentRecord {
    return this.agents.get(agentId);
  }

  setStatus(agentId: string, status: AgentStatus): AgentRecord {
    return this.agents.setStatus(agentId, status);
  }

  async replace(input: {
    agentId: string;
    threadId: string;
    workspace: string;
    expectedGeneration: number;
    confirmation: string;
  }): Promise<AgentRecord> {
    if (input.confirmation !== input.agentId) {
      throw new Error("replacement requires --confirm-agent-id matching the active agent ID");
    }
    await this.verifier.verify(input.threadId);
    return this.agents.replace(
      input.agentId,
      input.threadId,
      input.workspace,
      input.expectedGeneration,
    );
  }

  async adoptOwner(input: {
    agentId: string;
    expectedGeneration: number;
    confirmation: string;
  }): Promise<AgentRecord> {
    if (input.confirmation !== input.agentId) {
      throw new Error("owner adoption requires --confirm-agent-id matching the active agent ID");
    }
    const current = this.agents.get(input.agentId);
    if (current.generation !== input.expectedGeneration)
      throw new Error("agent generation changed");
    const verified = await this.verifier.verify(current.activeThreadId);
    if (verified.status !== "idle") {
      throw new Error("thread must be idle before authoritative owner adoption");
    }
    return this.agents.bindCurrentOwner(input.agentId, input.expectedGeneration);
  }

  discover(search: string): Promise<readonly { threadId: string; title: string | null }[]> {
    return this.verifier.discover(search);
  }

  setAcl(senderAgentId: string, recipientAgentId: string, allowed: boolean): AclRuleRecord {
    if (!this.acl) throw new Error("ACL administration is unavailable");
    this.agents.get(senderAgentId);
    this.agents.get(recipientAgentId);
    return this.acl.set(senderAgentId, recipientAgentId, allowed);
  }

  listAcl(): AclRuleRecord[] {
    if (!this.acl) throw new Error("ACL administration is unavailable");
    return this.acl.list();
  }

  removeAcl(senderAgentId: string, recipientAgentId: string): { removed: boolean } {
    if (!this.acl) throw new Error("ACL administration is unavailable");
    return { removed: this.acl.remove(senderAgentId, recipientAgentId) };
  }

  async health(): Promise<Record<string, unknown>> {
    const database = this.agents.store.database;
    const quickCheck = database.pragma("quick_check", { simple: true });
    const schema = database
      .prepare("SELECT COALESCE(max(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    const leases = database
      .prepare(
        "SELECT count(*) AS total, sum(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) AS expired FROM recipient_leases",
      )
      .get(new Date().toISOString()) as { total: number; expired: number | null };
    const unfinished = database
      .prepare(
        `SELECT status, count(*) AS count FROM messages
         WHERE status IN ('queued', 'dispatching', 'running') GROUP BY status ORDER BY status`,
      )
      .all() as Array<{ status: string; count: number }>;
    const asynchronousFailures = database
      .prepare(
        `SELECT status, count(*) AS count FROM messages
         WHERE expects_reply = 0 AND status IN ('failed', 'dead_letter')
         GROUP BY status ORDER BY status`,
      )
      .all() as Array<{ status: string; count: number }>;
    const groupCounts = database
      .prepare("SELECT status, count(*) AS count FROM groups GROUP BY status ORDER BY status")
      .all() as Array<{ status: string; count: number }>;
    const messageCounts = database
      .prepare("SELECT status, count(*) AS count FROM messages GROUP BY status ORDER BY status")
      .all() as Array<{ status: string; count: number }>;
    const auditEvents = database.prepare("SELECT count(*) AS count FROM audit_events").get() as {
      count: number;
    };
    const registered = this.agents.list().map((agent) => ({
      agentId: agent.agentId,
      generation: agent.generation,
      status: agent.status,
      acceptsMessages: agent.acceptsMessages,
    }));
    let appServer = false;
    try {
      appServer = (await this.verifier.health?.()) ?? false;
    } catch {
      appServer = false;
    }
    return {
      status: quickCheck === "ok" && appServer ? "healthy" : "degraded",
      database: { ok: quickCheck === "ok", schemaVersion: schema.version },
      appServer: { connected: appServer },
      registered,
      leases: { total: leases.total, expired: leases.expired ?? 0 },
      unfinished,
      asynchronousFailures,
      groups: groupCounts,
      messages: messageCounts,
      auditEvents: auditEvents.count,
    };
  }

  async backup(outputPath: string): Promise<{ status: "completed"; outputPath: string }> {
    const destination = path.resolve(outputPath);
    try {
      await access(destination);
      throw new Error("backup destination already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await this.agents.store.database.backup(destination);
    return { status: "completed", outputPath: destination };
  }

  createGroup(groupId: string, displayName: string, ownerAgentId: string) {
    if (!this.groups) throw new Error("group administration is unavailable");
    this.agents.get(ownerAgentId);
    return this.groups.create(groupId, displayName, ownerAgentId);
  }

  showGroup(groupId: string) {
    if (!this.groups) throw new Error("group administration is unavailable");
    return { group: this.groups.get(groupId), members: this.groups.members(groupId, false) };
  }

  addGroupMember(groupId: string, agentId: string) {
    if (!this.groups) throw new Error("group administration is unavailable");
    this.agents.get(agentId);
    return this.groups.addMember(groupId, agentId);
  }

  removeGroupMember(groupId: string, agentId: string): { removed: boolean } {
    if (!this.groups) throw new Error("group administration is unavailable");
    return { removed: this.groups.removeMember(groupId, agentId) };
  }

  setGroupStatus(groupId: string, status: GroupStatus) {
    if (!this.groups) throw new Error("group administration is unavailable");
    return this.groups.setStatus(groupId, status);
  }
}
