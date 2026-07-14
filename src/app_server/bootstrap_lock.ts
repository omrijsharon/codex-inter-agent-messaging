import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";

export const BOOTSTRAP_LOCK_SCHEMA_VERSION = 1;

export type BootstrapLockErrorCode = "HOST_LOCK_TIMEOUT" | "HOST_PERMISSION_DENIED";

export interface BootstrapLockRecord {
  readonly schemaVersion: typeof BOOTSTRAP_LOCK_SCHEMA_VERSION;
  readonly nonce: string;
  readonly pid: number;
  readonly createdAt: string;
}

export interface BootstrapLockDiagnostics {
  readonly attempts: number;
  readonly waitedMs: number;
  readonly staleRecoveryAttempts: number;
  readonly staleRecoveries: number;
  readonly owner: BootstrapLockRecord | null;
  readonly ownerMetadataValid: boolean;
}

export class BootstrapLockError extends Error {
  readonly code: BootstrapLockErrorCode;
  readonly diagnostics: BootstrapLockDiagnostics;

  constructor(
    code: BootstrapLockErrorCode,
    message: string,
    diagnostics: BootstrapLockDiagnostics,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BootstrapLockError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface BootstrapLockOwnerSnapshot {
  readonly record: BootstrapLockRecord;
  readonly ageMs: number;
}

/** Return true only when removing this stale lock is known to be safe. */
export type BootstrapLockOwnerValidator = (
  owner: BootstrapLockOwnerSnapshot,
) => boolean | Promise<boolean>;

export interface BootstrapLockFileSystem {
  createExclusive(filename: string, contents: string): Promise<void>;
  readText(filename: string): Promise<string>;
  modifiedTimeMs(filename: string): Promise<number>;
  remove(filename: string): Promise<void>;
}

export interface AcquireBootstrapLockOptions {
  readonly lockPath: string;
  readonly timeoutMs?: number;
  readonly staleAfterMs?: number;
  readonly initialBackoffMs?: number;
  readonly maximumBackoffMs?: number;
  readonly pid?: number;
  readonly now?: () => number;
  readonly createNonce?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly validateOwner?: BootstrapLockOwnerValidator;
  readonly fileSystem?: BootstrapLockFileSystem;
}

export interface BootstrapLockHandle {
  readonly record: BootstrapLockRecord;
  readonly diagnostics: BootstrapLockDiagnostics;
  /** Idempotently release this lock. Returns false if it no longer belongs to this handle. */
  release(): Promise<boolean>;
}

interface MutableDiagnostics {
  attempts: number;
  waitedMs: number;
  staleRecoveryAttempts: number;
  staleRecoveries: number;
  owner: BootstrapLockRecord | null;
  ownerMetadataValid: boolean;
}

const defaultFileSystem: BootstrapLockFileSystem = {
  async createExclusive(filename, contents) {
    const handle = await open(filename, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  readText: (filename) => readFile(filename, "utf8"),
  async modifiedTimeMs(filename) {
    return (await stat(filename)).mtimeMs;
  },
  remove: (filename) => unlink(filename),
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function isPermissionError(error: unknown): boolean {
  return new Set(["EACCES", "EPERM", "EROFS"]).has(errorCode(error) ?? "");
}

function isMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isExistingError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function snapshotDiagnostics(diagnostics: MutableDiagnostics, startedAt: number, now: number) {
  return {
    attempts: diagnostics.attempts,
    waitedMs: Math.max(0, now - startedAt),
    staleRecoveryAttempts: diagnostics.staleRecoveryAttempts,
    staleRecoveries: diagnostics.staleRecoveries,
    owner: diagnostics.owner,
    ownerMetadataValid: diagnostics.ownerMetadataValid,
  } satisfies BootstrapLockDiagnostics;
}

function permissionError(
  operation: string,
  cause: unknown,
  diagnostics: MutableDiagnostics,
  startedAt: number,
  now: number,
): BootstrapLockError {
  return new BootstrapLockError(
    "HOST_PERMISSION_DENIED",
    `permission denied while ${operation} the bootstrap lock`,
    snapshotDiagnostics(diagnostics, startedAt, now),
    { cause },
  );
}

function parseRecord(value: string): BootstrapLockRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !== BOOTSTRAP_LOCK_SCHEMA_VERSION ||
    typeof candidate.nonce !== "string" ||
    candidate.nonce.length === 0 ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) <= 0 ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt))
  ) {
    return null;
  }
  return {
    schemaVersion: BOOTSTRAP_LOCK_SCHEMA_VERSION,
    nonce: candidate.nonce,
    pid: candidate.pid as number,
    createdAt: candidate.createdAt,
  };
}

function defaultValidateOwner(owner: BootstrapLockOwnerSnapshot): boolean {
  try {
    process.kill(owner.record.pid, 0);
    return false;
  } catch (error) {
    // Signal 0 performs an existence check and never terminates the process.
    return errorCode(error) === "ESRCH";
  }
}

async function readOwner(
  filename: string,
  fileSystem: BootstrapLockFileSystem,
  now: number,
): Promise<{ record: BootstrapLockRecord | null; ageMs: number }> {
  const contents = await fileSystem.readText(filename);
  const record = parseRecord(contents);
  const createdAt =
    record === null ? await fileSystem.modifiedTimeMs(filename) : Date.parse(record.createdAt);
  return { record, ageMs: Math.max(0, now - createdAt) };
}

async function removeIfNonceMatches(
  filename: string,
  nonce: string,
  fileSystem: BootstrapLockFileSystem,
): Promise<boolean> {
  let current: BootstrapLockRecord | null;
  try {
    current = parseRecord(await fileSystem.readText(filename));
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
  if (current?.nonce !== nonce) return false;
  try {
    await fileSystem.remove(filename);
    return true;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
}

function validateOptions(
  options: AcquireBootstrapLockOptions,
): Required<
  Pick<
    AcquireBootstrapLockOptions,
    "timeoutMs" | "staleAfterMs" | "initialBackoffMs" | "maximumBackoffMs" | "pid"
  >
> {
  const values = {
    timeoutMs: options.timeoutMs ?? 10_000,
    staleAfterMs: options.staleAfterMs ?? 30_000,
    initialBackoffMs: options.initialBackoffMs ?? 20,
    maximumBackoffMs: options.maximumBackoffMs ?? 250,
    pid: options.pid ?? process.pid,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < (name === "pid" ? 1 : 0)) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (values.initialBackoffMs === 0 || values.maximumBackoffMs === 0) {
    throw new RangeError("bootstrap lock backoff values must be greater than zero");
  }
  return values;
}

export async function acquireBootstrapLock(
  options: AcquireBootstrapLockOptions,
): Promise<BootstrapLockHandle> {
  const limits = validateOptions(options);
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const createNonce = options.createNonce ?? randomUUID;
  const validateOwner = options.validateOwner ?? defaultValidateOwner;
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const startedAt = now();
  const record: BootstrapLockRecord = {
    schemaVersion: BOOTSTRAP_LOCK_SCHEMA_VERSION,
    nonce: createNonce(),
    pid: limits.pid,
    createdAt: new Date(startedAt).toISOString(),
  };
  const diagnostics: MutableDiagnostics = {
    attempts: 0,
    waitedMs: 0,
    staleRecoveryAttempts: 0,
    staleRecoveries: 0,
    owner: null,
    ownerMetadataValid: true,
  };
  let backoffMs = limits.initialBackoffMs;

  while (true) {
    diagnostics.attempts += 1;
    try {
      await fileSystem.createExclusive(options.lockPath, `${JSON.stringify(record)}\n`);
      let released = false;
      return {
        record,
        diagnostics: snapshotDiagnostics(diagnostics, startedAt, now()),
        async release() {
          if (released) return false;
          try {
            const removed = await removeIfNonceMatches(options.lockPath, record.nonce, fileSystem);
            if (removed) released = true;
            return removed;
          } catch (error) {
            if (isPermissionError(error)) {
              throw permissionError("releasing", error, diagnostics, startedAt, now());
            }
            throw error;
          }
        },
      };
    } catch (error) {
      if (isPermissionError(error)) {
        throw permissionError("acquiring", error, diagnostics, startedAt, now());
      }
      if (!isExistingError(error)) throw error;
    }

    try {
      const owner = await readOwner(options.lockPath, fileSystem, now());
      diagnostics.owner = owner.record;
      diagnostics.ownerMetadataValid = owner.record !== null;
      if (owner.record !== null && owner.ageMs > limits.staleAfterMs) {
        diagnostics.staleRecoveryAttempts += 1;
        if (await validateOwner({ record: owner.record, ageMs: owner.ageMs })) {
          try {
            if (await removeIfNonceMatches(options.lockPath, owner.record.nonce, fileSystem)) {
              diagnostics.staleRecoveries += 1;
              continue;
            }
          } catch (error) {
            if (isPermissionError(error)) {
              throw permissionError("recovering", error, diagnostics, startedAt, now());
            }
            throw error;
          }
        }
      }
    } catch (error) {
      if (error instanceof BootstrapLockError) throw error;
      if (isPermissionError(error)) {
        throw permissionError("inspecting", error, diagnostics, startedAt, now());
      }
      if (!isMissingError(error)) throw error;
      continue;
    }

    const elapsed = Math.max(0, now() - startedAt);
    if (elapsed >= limits.timeoutMs) {
      throw new BootstrapLockError(
        "HOST_LOCK_TIMEOUT",
        `timed out after ${elapsed}ms waiting for the bootstrap lock`,
        snapshotDiagnostics(diagnostics, startedAt, now()),
      );
    }
    const delay = Math.min(backoffMs, limits.timeoutMs - elapsed);
    await sleep(delay);
    backoffMs = Math.min(limits.maximumBackoffMs, backoffMs * 2);
  }
}
