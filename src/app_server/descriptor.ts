import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, link, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const HOST_DESCRIPTOR_SCHEMA_VERSION = 3 as const;
const SIGNING_CONTEXT = "codex-inter-agent/host-descriptor/v3";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackUrl(value: string, protocols: ReadonlySet<string>): boolean {
  try {
    const candidate = new URL(value);
    return (
      protocols.has(candidate.protocol) &&
      LOOPBACK_HOSTS.has(candidate.hostname.toLowerCase()) &&
      candidate.username.length === 0 &&
      candidate.password.length === 0
    );
  } catch {
    return false;
  }
}

const webSocketUrlSchema = z
  .string()
  .url()
  .refine((value) => isLoopbackUrl(value, new Set(["ws:", "wss:"])), {
    error: "url must be a loopback ws:// or wss:// URL without embedded credentials",
  });

const controlUrlSchema = z
  .string()
  .url()
  .refine((value) => isLoopbackUrl(value, new Set(["http:", "https:"])), {
    error: "controlUrl must be a loopback http:// or https:// URL without embedded credentials",
  });

export const HostDescriptorSchema = z
  .object({
    schemaVersion: z.literal(HOST_DESCRIPTOR_SCHEMA_VERSION),
    bridgeVersion: z.string().trim().min(1),
    protocolVersion: z.string().trim().min(1),
    ownerMode: z.literal("bridge-managed"),
    installationId: z.string().trim().min(1),
    databaseId: z.string().trim().min(1),
    ownershipGeneration: z.uuid(),
    transport: z.literal("websocket"),
    capabilityTokenMode: z.literal("capability-token"),
    appServerUserAgent: z.string().trim().min(1),
    hostNonce: z.string().trim().min(16),
    supervisorPid: z.number().int().positive(),
    appServerPid: z.number().int().positive(),
    url: webSocketUrlSchema,
    controlUrl: controlUrlSchema,
    startedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type HostDescriptor = z.infer<typeof HostDescriptorSchema>;

export const SignedHostDescriptorSchema = HostDescriptorSchema.extend({
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type SignedHostDescriptor = z.infer<typeof SignedHostDescriptorSchema>;

export type HostDescriptorErrorCode =
  "DESCRIPTOR_INVALID" | "DESCRIPTOR_INCOMPATIBLE" | "SIGNATURE_INVALID";

export class HostDescriptorError extends Error {
  readonly code: HostDescriptorErrorCode;

  constructor(code: HostDescriptorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostDescriptorError";
    this.code = code;
  }
}

export type HostDescriptorReadResult =
  | { readonly status: "valid"; readonly descriptor: HostDescriptor }
  | { readonly status: "missing" }
  | {
      readonly status: "invalid";
      readonly error: HostDescriptorError;
      readonly quarantinedPath: string | null;
    };

function signingKey(capabilityToken: string): Buffer {
  if (capabilityToken.trim().length < 32) {
    throw new HostDescriptorError(
      "SIGNATURE_INVALID",
      "capability token is too short to authenticate a host descriptor",
    );
  }
  return createHash("sha256")
    .update(SIGNING_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(capabilityToken, "utf8")
    .digest();
}

function canonicalDescriptor(descriptor: HostDescriptor): string {
  return JSON.stringify({
    schemaVersion: descriptor.schemaVersion,
    bridgeVersion: descriptor.bridgeVersion,
    protocolVersion: descriptor.protocolVersion,
    ownerMode: descriptor.ownerMode,
    installationId: descriptor.installationId,
    databaseId: descriptor.databaseId,
    ownershipGeneration: descriptor.ownershipGeneration,
    transport: descriptor.transport,
    capabilityTokenMode: descriptor.capabilityTokenMode,
    appServerUserAgent: descriptor.appServerUserAgent,
    hostNonce: descriptor.hostNonce,
    supervisorPid: descriptor.supervisorPid,
    appServerPid: descriptor.appServerPid,
    url: descriptor.url,
    controlUrl: descriptor.controlUrl,
    startedAt: descriptor.startedAt,
  });
}

function signatureFor(descriptor: HostDescriptor, capabilityToken: string): string {
  return createHmac("sha256", signingKey(capabilityToken))
    .update(canonicalDescriptor(descriptor), "utf8")
    .digest("hex");
}

export function signHostDescriptor(
  descriptor: HostDescriptor,
  capabilityToken: string,
): SignedHostDescriptor {
  const parsed = HostDescriptorSchema.parse(descriptor);
  return { ...parsed, signature: signatureFor(parsed, capabilityToken) };
}

function descriptorSchemaVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Reflect.get(value, "schemaVersion");
}

function displaySchemaVersion(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  return typeof value;
}

export function verifyHostDescriptor(value: unknown, capabilityToken: string): HostDescriptor {
  const version = descriptorSchemaVersion(value);
  if (version !== undefined && version !== HOST_DESCRIPTOR_SCHEMA_VERSION) {
    throw new HostDescriptorError(
      "DESCRIPTOR_INCOMPATIBLE",
      `host descriptor schema version ${displaySchemaVersion(version)} is incompatible with version ${HOST_DESCRIPTOR_SCHEMA_VERSION}`,
    );
  }

  const parsed = SignedHostDescriptorSchema.safeParse(value);
  if (!parsed.success) {
    throw new HostDescriptorError("DESCRIPTOR_INVALID", "host descriptor is invalid", {
      cause: parsed.error,
    });
  }
  const { signature, ...descriptor } = parsed.data;
  const expected = Buffer.from(signatureFor(descriptor, capabilityToken), "hex");
  const actual = Buffer.from(signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new HostDescriptorError(
      "SIGNATURE_INVALID",
      "host descriptor signature verification failed",
    );
  }
  return descriptor;
}

function temporaryPath(descriptorPath: string, purpose: string): string {
  return `${descriptorPath}.${purpose}.${process.pid}.${randomBytes(8).toString("hex")}`;
}

async function quarantineDescriptor(descriptorPath: string): Promise<string | null> {
  const quarantinePath = `${descriptorPath}.corrupt.${new Date().toISOString().replaceAll(":", "-")}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await rename(descriptorPath, quarantinePath);
    return quarantinePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeHostDescriptor(
  descriptorPath: string,
  descriptor: HostDescriptor,
  capabilityToken: string,
): Promise<SignedHostDescriptor> {
  const signed = signHostDescriptor(descriptor, capabilityToken);
  await mkdir(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
  const pendingPath = temporaryPath(descriptorPath, "pending");
  try {
    const handle = await open(
      pendingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(signed)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(pendingPath, descriptorPath);
    return signed;
  } finally {
    await rm(pendingPath, { force: true });
  }
}

export async function readHostDescriptor(
  descriptorPath: string,
  capabilityToken: string,
): Promise<HostDescriptorReadResult> {
  let raw: string;
  try {
    raw = await readFile(descriptorPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    const error = new HostDescriptorError("DESCRIPTOR_INVALID", "host descriptor is not JSON", {
      cause,
    });
    return {
      status: "invalid",
      error,
      quarantinedPath: await quarantineDescriptor(descriptorPath),
    };
  }

  try {
    return { status: "valid", descriptor: verifyHostDescriptor(value, capabilityToken) };
  } catch (cause) {
    if (!(cause instanceof HostDescriptorError)) throw cause;
    const shouldQuarantine = cause.code === "DESCRIPTOR_INVALID";
    return {
      status: "invalid",
      error: cause,
      quarantinedPath: shouldQuarantine ? await quarantineDescriptor(descriptorPath) : null,
    };
  }
}

async function restoreClaimedDescriptor(
  claimedPath: string,
  descriptorPath: string,
): Promise<void> {
  try {
    await link(claimedPath, descriptorPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(claimedPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export async function removeHostDescriptorIfOwned(
  descriptorPath: string,
  expectedHostNonce: string,
  capabilityToken: string,
): Promise<boolean> {
  const claimedPath = temporaryPath(descriptorPath, "removing");
  try {
    await rename(descriptorPath, claimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  let raw: string;
  try {
    raw = await readFile(claimedPath, "utf8");
    const descriptor = verifyHostDescriptor(JSON.parse(raw) as unknown, capabilityToken);
    if (descriptor.hostNonce !== expectedHostNonce) {
      await restoreClaimedDescriptor(claimedPath, descriptorPath);
      return false;
    }
    await unlink(claimedPath);
    return true;
  } catch (error) {
    try {
      await restoreClaimedDescriptor(claimedPath, descriptorPath);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "failed to restore unowned host descriptor");
    }
    throw error;
  }
}
