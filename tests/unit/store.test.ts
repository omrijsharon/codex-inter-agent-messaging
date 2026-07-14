import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../../src/store/database.js";
import { migration001 } from "../../src/store/migrations/001_initial.js";
import { migration002 } from "../../src/store/migrations/002_reliability.js";
import { migration003 } from "../../src/store/migrations/003_security.js";
import { migration004 } from "../../src/store/migrations/004_async.js";
import {
  AclRepository,
  AgentRepository,
  AuditRepository,
  MessageRepository,
  RecipientLeaseRepository,
} from "../../src/store/repositories.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function databasePair() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-db-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "bridge.sqlite3");
  const first = new BridgeDatabase(filename);
  cleanup.push(() => {
    first.close();
    return Promise.resolve();
  });
  return { directory, filename, first };
}

describe("durable store", () => {
  it("applies migrations idempotently with WAL, foreign keys, and full sync", async () => {
    const { filename, first } = await databasePair();
    expect(first.database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(first.database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(first.database.pragma("synchronous", { simple: true })).toBe(2);
    expect(first.database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual(
      {
        count: 5,
      },
    );
    const reopened = new BridgeDatabase(filename);
    cleanup.push(() => {
      reopened.close();
      return Promise.resolve();
    });
    expect(
      reopened.database.prepare("SELECT count(*) AS count FROM schema_migrations").get(),
    ).toEqual({
      count: 5,
    });
  });

  it("upgrades a v1 database in place without losing registered agents", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-upgrade-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "legacy.sqlite3");
    const legacy = new Database(filename);
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    legacy.exec(migration001.sql);
    legacy
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(1, migration001.name, "2026-07-14T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO agents(agent_id, display_name, active_thread_id, generation, workspace,
          accepts_messages, status, created_at, updated_at)
         VALUES ('legacy', 'Legacy', 'thread_legacy', 1, 'C:/legacy', 1, 'active', ?, ?)`,
      )
      .run("2026-07-14T00:00:00.000Z", "2026-07-14T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO agent_thread_generations(agent_id, generation, thread_id, status, created_at)
         VALUES ('legacy', 1, 'thread_legacy', 'active', ?)`,
      )
      .run("2026-07-14T00:00:00.000Z");
    legacy.close();

    const upgraded = new BridgeDatabase(filename);
    cleanup.push(() => {
      upgraded.close();
      return Promise.resolve();
    });
    expect(
      upgraded.database.prepare("SELECT max(version) AS version FROM schema_migrations").get(),
    ).toEqual({ version: 5 });
    expect(new AgentRepository(upgraded).get("legacy")).toMatchObject({
      activeThreadId: "thread_legacy",
      generation: 1,
    });
    expect(
      upgraded.database
        .prepare("SELECT name FROM pragma_table_info('messages') WHERE name = 'group_message_id'")
        .get(),
    ).toEqual({ name: "group_message_id" });
  });

  it.each([
    [3, [migration001, migration002, migration003]],
    [4, [migration001, migration002, migration003, migration004]],
  ] as const)("upgrades the released schema v%i to v5", async (_version, migrations) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-upgrade-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "released.sqlite3");
    const legacy = new Database(filename);
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    for (const migration of migrations) {
      legacy.exec(migration.sql);
      legacy
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, "2026-07-14T00:00:00.000Z");
    }
    legacy.close();

    const upgraded = new BridgeDatabase(filename);
    cleanup.push(() => {
      upgraded.close();
      return Promise.resolve();
    });
    expect(
      upgraded.database.prepare("SELECT max(version) AS version FROM schema_migrations").get(),
    ).toEqual({ version: 5 });
    expect(
      upgraded.database
        .prepare("SELECT count(*) AS count FROM schema_migrations WHERE checksum IS NULL")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rejects future schemas and changed recorded migration bodies", async () => {
    const { first } = await databasePair();
    first.database
      .prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 5")
      .run();
    expect(() => first.migrate()).toThrow(/checksum/);
    first.database.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
    first.database
      .prepare(
        "INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (99, 'future', ?, 'future')",
      )
      .run("2026-07-14T00:00:00.000Z");
    expect(() => first.migrate()).toThrow(/newer than this binary/);
  });

  it("registers stable agents, enforces unique threads, and replaces generations atomically", async () => {
    const { first } = await databasePair();
    const agents = new AgentRepository(first);
    const initial = agents.register({
      agentId: "cfo",
      displayName: "CFO",
      threadId: "thread_1",
      workspace: "C:/workspace/cfo",
    });
    expect(initial).toMatchObject({ generation: 1, status: "active", acceptsMessages: true });
    expect(() =>
      agents.register({
        agentId: "legal",
        displayName: "Legal",
        threadId: "thread_1",
        workspace: "C:/workspace/legal",
      }),
    ).toThrow();
    expect(agents.setStatus("cfo", "paused")).toMatchObject({ acceptsMessages: false });
    expect(agents.setStatus("cfo", "active")).toMatchObject({ acceptsMessages: true });
    const replaced = agents.replace("cfo", "thread_2", "C:/workspace/cfo2", 1);
    expect(replaced).toMatchObject({ generation: 2, activeThreadId: "thread_2" });
    expect(() => agents.replace("cfo", "thread_3", "C:/workspace", 1)).toThrow(/generation/);
    expect(
      first.database
        .prepare("SELECT status FROM agent_thread_generations WHERE thread_id = 'thread_1'")
        .get(),
    ).toEqual({ status: "superseded" });
  });

  it("persists messages, attempts, terminal results, and rejects invalid transitions", async () => {
    const { first } = await databasePair();
    const agents = new AgentRepository(first);
    for (const [agentId, threadId] of [
      ["sender", "thread_sender"],
      ["recipient", "thread_recipient"],
    ] as const) {
      agents.register({ agentId, displayName: agentId, threadId, workspace: `C:/${agentId}` });
    }
    const messages = new MessageRepository(first);
    const created = messages.create({
      messageId: "msg_1",
      conversationId: "conv_1",
      senderAgentId: "sender",
      recipientAgentId: "recipient",
      recipientGeneration: 1,
      kind: "request",
      body: "question",
      expectsReply: true,
      hopCount: 0,
      callChain: ["sender"],
    });
    expect(created.status).toBe("queued");
    expect(() => messages.transition("msg_1", "completed")).toThrow(/invalid/);
    messages.transition("msg_1", "dispatching");
    const attemptId = messages.startAttempt("msg_1", "rpc_1");
    messages.transition("msg_1", "running", {
      delivered_at: "2026-07-14T00:00:00.000Z",
      target_thread_id: "thread_recipient",
      target_turn_id: "turn_1",
    });
    messages.finishAttempt(attemptId, "completed", "turn_1");
    const completed = messages.transition("msg_1", "completed", {
      completed_at: "2026-07-14T00:00:01.000Z",
      reply_body: "answer",
    });
    expect(completed).toMatchObject({ status: "completed", replyBody: "answer", attemptCount: 1 });
    expect(new AuditRepository(first).forMessage("msg_1").map((event) => event.eventType)).toEqual([
      "message.created",
      "message.dispatching",
      "attempt.started",
      "message.running",
      "attempt.finished",
      "message.completed",
    ]);
    expect(() => messages.transition("msg_1", "failed")).toThrow(/invalid/);
  });

  it("evaluates durable ACL rules with configurable default denial", async () => {
    const { first } = await databasePair();
    const agents = new AgentRepository(first);
    agents.register({
      agentId: "sender",
      displayName: "Sender",
      threadId: "thread_s",
      workspace: "C:/s",
    });
    agents.register({
      agentId: "recipient",
      displayName: "Recipient",
      threadId: "thread_r",
      workspace: "C:/r",
    });
    const acl = new AclRepository(first);
    expect(acl.isAllowed("sender", "recipient", false)).toBe(false);
    expect(acl.set("sender", "recipient", true)).toMatchObject({ allowed: true });
    expect(acl.isAllowed("sender", "recipient", false)).toBe(true);
    expect(acl.set("sender", "recipient", false)).toMatchObject({ allowed: false });
    expect(acl.isAllowed("sender", "recipient", true)).toBe(false);
    expect(acl.remove("sender", "recipient")).toBe(true);
  });

  it("deduplicates accepted requests, orders queues, and detects dependency cycles", async () => {
    const { first } = await databasePair();
    const agents = new AgentRepository(first);
    for (const [agentId, threadId] of [
      ["sender", "thread_sender"],
      ["recipient", "thread_recipient"],
    ] as const) {
      agents.register({ agentId, displayName: agentId, threadId, workspace: `C:/${agentId}` });
    }
    const messages = new MessageRepository(first);
    const input = {
      conversationId: "conv_fifo",
      senderAgentId: "sender",
      recipientAgentId: "recipient",
      recipientGeneration: 1,
      kind: "request" as const,
      body: "same request",
      expectsReply: true,
      hopCount: 0,
      callChain: ["sender"],
      idempotencyKey: "idem_1",
    };
    const firstMessage = messages.create({ ...input, messageId: "msg_first" });
    const duplicate = messages.create({ ...input, messageId: "msg_duplicate" });
    expect(duplicate.messageId).toBe(firstMessage.messageId);
    expect(messages.queueDepth("recipient")).toBe(1);
    expect(messages.queueHead("recipient", 1)?.messageId).toBe("msg_first");
    expect(messages.wouldCreateCycle("recipient", "sender")).toBe(true);
    expect(() =>
      messages.create({ ...input, messageId: "msg_conflict", body: "different" }),
    ).toThrow(/different request/);
    messages.transition("msg_first", "failed");
    messages.closeDependency("msg_first");
    expect(messages.wouldCreateCycle("recipient", "sender")).toBe(false);
  });

  it("serializes recipient leases across database connections and validates ownership tokens", async () => {
    const { filename, first } = await databasePair();
    const second = new BridgeDatabase(filename);
    cleanup.push(() => {
      second.close();
      return Promise.resolve();
    });
    const leasesA = new RecipientLeaseRepository(first);
    const leasesB = new RecipientLeaseRepository(second);
    const token = leasesA.acquire("thread_target", "instance_a", 1_000, 10_000);
    expect(token).toMatch(/^lease_/);
    expect(leasesB.acquire("thread_target", "instance_b", 1_000, 10_100)).toBeNull();
    expect(leasesB.release("thread_target", "wrong")).toBe(false);
    expect(leasesA.renew("thread_target", token ?? "", 1_000, 10_500)).toBe(true);
    expect(leasesA.release("thread_target", token ?? "")).toBe(true);
    expect(leasesB.acquire("thread_target", "instance_b", 1_000, 11_000)).toMatch(/^lease_/);
  });

  it("preserves agent mappings and conversation identifiers across process reopen", async () => {
    const { filename, first } = await databasePair();
    const agents = new AgentRepository(first);
    agents.register({
      agentId: "sender",
      displayName: "Sender",
      threadId: "thread_s",
      workspace: "C:/s",
    });
    agents.register({
      agentId: "recipient",
      displayName: "Recipient",
      threadId: "thread_r",
      workspace: "C:/r",
    });
    new MessageRepository(first).create({
      messageId: "msg_compaction",
      conversationId: "conv_survives_compaction",
      senderAgentId: "sender",
      recipientAgentId: "recipient",
      recipientGeneration: 1,
      kind: "request",
      body: "preserve IDs",
      expectsReply: true,
      hopCount: 0,
      callChain: ["sender"],
    });
    const reopened = new BridgeDatabase(filename);
    cleanup.push(() => {
      reopened.close();
      return Promise.resolve();
    });
    expect(new AgentRepository(reopened).get("recipient")).toMatchObject({
      activeThreadId: "thread_r",
      generation: 1,
    });
    expect(new MessageRepository(reopened).get("msg_compaction")).toMatchObject({
      conversationId: "conv_survives_compaction",
      recipientAgentId: "recipient",
    });
  });
});
