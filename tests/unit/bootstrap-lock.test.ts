import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_LOCK_SCHEMA_VERSION,
  BootstrapLockError,
  acquireBootstrapLock,
  type BootstrapLockFileSystem,
  type BootstrapLockRecord,
} from "../../src/app_server/bootstrap_lock.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function temporaryLock() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-bootstrap-lock-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "startup.lock");
}

function lockRecord(overrides: Partial<BootstrapLockRecord> = {}): BootstrapLockRecord {
  return {
    schemaVersion: BOOTSTRAP_LOCK_SCHEMA_VERSION,
    nonce: "owner-nonce",
    pid: 4242,
    createdAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("bootstrap startup lock", () => {
  it("creates the lock exclusively with owner diagnostics and releases it", async () => {
    const lockPath = await temporaryLock();
    const handle = await acquireBootstrapLock({
      lockPath,
      now: () => Date.parse("2026-07-14T10:00:00.000Z"),
      pid: 1234,
      createNonce: () => "new-owner",
    });

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({
      schemaVersion: 1,
      nonce: "new-owner",
      pid: 1234,
      createdAt: "2026-07-14T10:00:00.000Z",
    });
    expect(handle.diagnostics).toMatchObject({ attempts: 1, waitedMs: 0 });
    await expect(handle.release()).resolves.toBe(true);
    await expect(handle.release()).resolves.toBe(false);
  });

  it("waits with bounded backoff and converges after the owner releases", async () => {
    const lockPath = await temporaryLock();
    const owner = await acquireBootstrapLock({ lockPath, createNonce: () => "first" });
    let clock = 0;
    const sleeps: number[] = [];

    const waiter = await acquireBootstrapLock({
      lockPath,
      timeoutMs: 100,
      initialBackoffMs: 10,
      maximumBackoffMs: 20,
      now: () => clock,
      createNonce: () => "second",
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
        await owner.release();
      },
    });

    expect(sleeps).toEqual([10]);
    expect(waiter.diagnostics).toMatchObject({ attempts: 2, waitedMs: 10 });
    await waiter.release();
  });

  it("times out without stealing a live lock and reports its owner", async () => {
    const lockPath = await temporaryLock();
    await writeFile(lockPath, `${JSON.stringify(lockRecord())}\n`, "utf8");
    let clock = Date.parse("2026-07-14T00:00:00.010Z");

    const result = acquireBootstrapLock({
      lockPath,
      timeoutMs: 25,
      staleAfterMs: 1_000,
      initialBackoffMs: 10,
      maximumBackoffMs: 20,
      now: () => clock,
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
    });

    await expect(result).rejects.toMatchObject({
      code: "HOST_LOCK_TIMEOUT",
      diagnostics: {
        attempts: 3,
        waitedMs: 25,
        staleRecoveryAttempts: 0,
        owner: lockRecord(),
      },
    });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(lockRecord());
  });

  it("recovers a sufficiently old lock only after owner validation", async () => {
    const lockPath = await temporaryLock();
    await writeFile(lockPath, JSON.stringify(lockRecord()), "utf8");
    const validateOwner = vi.fn().mockResolvedValue(true);

    const handle = await acquireBootstrapLock({
      lockPath,
      staleAfterMs: 5_000,
      now: () => Date.parse("2026-07-14T00:00:10.000Z"),
      validateOwner,
      createNonce: () => "replacement",
    });

    expect(validateOwner).toHaveBeenCalledWith({ record: lockRecord(), ageMs: 10_000 });
    expect(handle.diagnostics).toMatchObject({
      attempts: 2,
      staleRecoveryAttempts: 1,
      staleRecoveries: 1,
    });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ nonce: "replacement" });
    await handle.release();
  });

  it("does not recover a fresh lock even when the validator would allow it", async () => {
    const lockPath = await temporaryLock();
    await writeFile(lockPath, JSON.stringify(lockRecord()), "utf8");
    const validateOwner = vi.fn().mockResolvedValue(true);
    let clock = Date.parse("2026-07-14T00:00:00.100Z");

    await expect(
      acquireBootstrapLock({
        lockPath,
        timeoutMs: 1,
        staleAfterMs: 5_000,
        now: () => clock,
        sleep: (milliseconds) => {
          clock += milliseconds;
          return Promise.resolve();
        },
        validateOwner,
      }),
    ).rejects.toMatchObject({ code: "HOST_LOCK_TIMEOUT" });
    expect(validateOwner).not.toHaveBeenCalled();
  });

  it("never removes a replacement lock whose nonce no longer matches", async () => {
    const lockPath = await temporaryLock();
    const handle = await acquireBootstrapLock({ lockPath, createNonce: () => "ours" });
    await writeFile(lockPath, JSON.stringify(lockRecord({ nonce: "theirs" })), "utf8");

    await expect(handle.release()).resolves.toBe(false);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ nonce: "theirs" });
  });

  it("classifies filesystem permission denial with typed diagnostics", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const fileSystem: BootstrapLockFileSystem = {
      createExclusive: vi.fn().mockRejectedValue(denied),
      readText: vi.fn(),
      modifiedTimeMs: vi.fn(),
      remove: vi.fn(),
    };

    const result = acquireBootstrapLock({ lockPath: "ignored", fileSystem });
    await expect(result).rejects.toBeInstanceOf(BootstrapLockError);
    await expect(result).rejects.toMatchObject({
      code: "HOST_PERMISSION_DENIED",
      diagnostics: { attempts: 1, owner: null },
    });
  });
});
