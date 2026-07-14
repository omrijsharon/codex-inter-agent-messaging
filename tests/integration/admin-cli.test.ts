import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminService, type ThreadVerifier } from "../../src/cli/admin_service.js";
import { type CliRuntime, type HostLifecycle, runCli } from "../../src/cli/main.js";
import { BridgeDatabase } from "../../src/store/database.js";
import { AclRepository, AgentRepository } from "../../src/store/repositories.js";
import { GroupRepository } from "../../src/store/groups.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("administrative CLI", () => {
  it("verifies and manages registrations, status, discovery, and confirmed replacement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-cli-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "bridge.sqlite3");
    const verified: string[] = [];
    const verifier: ThreadVerifier = {
      verify(threadId) {
        verified.push(threadId);
        if (threadId === "missing") return Promise.reject(new Error("thread not found"));
        return Promise.resolve({ threadId, status: "idle" });
      },
      discover(search) {
        return Promise.resolve([{ threadId: "thread_discovered", title: `Result ${search}` }]);
      },
      health() {
        return Promise.resolve(true);
      },
    };
    const factory = (): Promise<CliRuntime> => {
      const store = new BridgeDatabase(filename);
      return Promise.resolve({
        service: new AdminService(
          new AgentRepository(store, {
            ownerMode: "bridge-managed",
            installationId: "admin-test-installation",
            databaseId: "admin-test-database",
            protocolVersion: "1",
          }),
          verifier,
          new AclRepository(store),
          new GroupRepository(store),
        ),
        close() {
          store.close();
          return Promise.resolve();
        },
      });
    };
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(
      [
        "register",
        "--agent-id",
        "cfo",
        "--display-name",
        "CFO",
        "--thread-id",
        "thread_1",
        "--workspace",
        "C:/cfo",
      ],
      factory,
    );
    await expect(
      runCli(
        [
          "register",
          "--agent-id",
          "bad",
          "--display-name",
          "Bad",
          "--thread-id",
          "missing",
          "--workspace",
          "C:/bad",
        ],
        factory,
      ),
    ).rejects.toThrow("thread not found");
    await runCli(["list"], factory);
    await runCli(["show", "cfo"], factory);
    await runCli(["pause", "cfo"], factory);
    await runCli(["resume", "cfo"], factory);
    await expect(
      runCli(
        [
          "replace",
          "cfo",
          "--thread-id",
          "thread_2",
          "--workspace",
          "C:/cfo2",
          "--generation",
          "1",
          "--confirm-agent-id",
          "wrong",
        ],
        factory,
      ),
    ).rejects.toThrow(/confirm-agent-id/);
    await runCli(
      [
        "replace",
        "cfo",
        "--thread-id",
        "thread_2",
        "--workspace",
        "C:/cfo2",
        "--generation",
        "1",
        "--confirm-agent-id",
        "cfo",
      ],
      factory,
    );
    await runCli(["adopt-owner", "cfo", "--generation", "2", "--confirm-agent-id", "cfo"], factory);
    await runCli(["supersede", "cfo"], factory);
    await runCli(
      [
        "register",
        "--agent-id",
        "legal",
        "--display-name",
        "Legal",
        "--thread-id",
        "thread_legal",
        "--workspace",
        "C:/legal",
      ],
      factory,
    );
    await runCli(["disable", "legal"], factory);
    await runCli(["acl", "allow", "cfo", "legal"], factory);
    await runCli(["acl", "list"], factory);
    await runCli(["acl", "deny", "cfo", "legal"], factory);
    await runCli(["acl", "remove", "cfo", "legal"], factory);
    const hostLifecycle: HostLifecycle = {
      status: () => Promise.resolve({ state: "stopped" }),
      start: () => Promise.reject(new Error("not used")),
      stop: () => Promise.resolve({ status: "already-stopped" }),
      restart: () => Promise.reject(new Error("not used")),
    };
    await runCli(["health"], factory, hostLifecycle);
    const backupPath = path.join(directory, "backups", "bridge.sqlite3");
    await runCli(["backup", "--output", backupPath], factory);
    expect((await stat(backupPath)).size).toBeGreaterThan(0);
    const restored = new BridgeDatabase(backupPath);
    expect(new AgentRepository(restored).get("cfo")).toMatchObject({
      generation: 2,
      activeThreadId: "thread_2",
      status: "superseded",
    });
    restored.close();
    await runCli(
      [
        "group",
        "create",
        "--group-id",
        "reviewers",
        "--display-name",
        "Reviewers",
        "--owner-agent-id",
        "cfo",
      ],
      factory,
    );
    await runCli(["group", "add", "reviewers", "legal"], factory);
    await runCli(["group", "show", "reviewers"], factory);
    await runCli(["group", "pause", "reviewers"], factory);
    await runCli(["group", "resume", "reviewers"], factory);
    await runCli(["group", "remove", "reviewers", "legal"], factory);
    await runCli(["group", "delete", "reviewers"], factory);
    await runCli(["discover", "Finance"], factory);

    expect(verified).toEqual(["thread_1", "missing", "thread_2", "thread_2", "thread_legal"]);
    expect(output.mock.calls.flat().join("")).toContain("thread_discovered");
    expect(output.mock.calls.flat().join("")).toContain('"status": "healthy"');
    const finalStore = new BridgeDatabase(filename);
    cleanup.push(() => {
      finalStore.close();
      return Promise.resolve();
    });
    expect(new AgentRepository(finalStore).get("cfo")).toMatchObject({
      generation: 2,
      activeThreadId: "thread_2",
      status: "superseded",
    });
    expect(new AgentRepository(finalStore).get("legal")).toMatchObject({ status: "disabled" });
  });
});
