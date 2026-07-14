import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostDescriptorError,
  HostDescriptorSchema,
  readHostDescriptor,
  removeHostDescriptorIfOwned,
  signHostDescriptor,
  verifyHostDescriptor,
  writeHostDescriptor,
  type HostDescriptor,
} from "../../src/app_server/descriptor.js";

const TOKEN = "test-capability-token-that-is-at-least-thirty-two-characters";
const directories: string[] = [];

function descriptor(overrides: Partial<HostDescriptor> = {}): HostDescriptor {
  return {
    schemaVersion: 3,
    bridgeVersion: "0.4.0",
    protocolVersion: "codex-0.144",
    ownerMode: "bridge-managed",
    installationId: "installation-test",
    databaseId: "database-test",
    ownershipGeneration: "00000000-0000-4000-8000-000000000003",
    transport: "websocket",
    capabilityTokenMode: "capability-token",
    appServerUserAgent: "codex-cli/0.144.0-alpha.4",
    hostNonce: "host-nonce-0123456789abcdef",
    supervisorPid: 1234,
    appServerPid: 5678,
    url: "ws://127.0.0.1:43210",
    controlUrl: "http://localhost:43211",
    startedAt: "2026-07-14T18:00:00.000+03:00",
    ...overrides,
  };
}

async function workspace(): Promise<{ directory: string; descriptorPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-descriptor-"));
  directories.push(directory);
  return { directory, descriptorPath: path.join(directory, "host.json") };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("host descriptor", () => {
  it("strictly validates schema version, owner mode, and local transports", () => {
    expect(HostDescriptorSchema.parse(descriptor())).toEqual(descriptor());
    expect(HostDescriptorSchema.parse(descriptor({ url: "wss://[::1]:443" }))).toBeDefined();
    expect(
      HostDescriptorSchema.parse(descriptor({ controlUrl: "https://127.0.0.1:443/health" })),
    ).toBeDefined();

    expect(() => HostDescriptorSchema.parse({ ...descriptor(), extra: true })).toThrow();
    expect(() => HostDescriptorSchema.parse({ ...descriptor(), schemaVersion: 1 })).toThrow();
    expect(() => HostDescriptorSchema.parse({ ...descriptor(), ownerMode: "desktop" })).toThrow();
    expect(() =>
      HostDescriptorSchema.parse(descriptor({ url: "http://localhost:1234" })),
    ).toThrow();
    expect(() =>
      HostDescriptorSchema.parse(descriptor({ url: "ws://192.168.1.5:1234" })),
    ).toThrow();
    expect(() =>
      HostDescriptorSchema.parse(descriptor({ controlUrl: "ws://localhost:1234" })),
    ).toThrow();
    expect(() =>
      HostDescriptorSchema.parse(descriptor({ controlUrl: "https://example.com/readyz" })),
    ).toThrow();
    expect(() =>
      HostDescriptorSchema.parse(descriptor({ url: "ws://user:password@localhost:1234" })),
    ).toThrow();
  });

  it("signs deterministically and detects descriptor tampering", () => {
    const signed = signHostDescriptor(descriptor(), TOKEN);
    expect(signed.signature).toMatch(/^[a-f0-9]{64}$/u);
    expect(signHostDescriptor(descriptor(), TOKEN)).toEqual(signed);
    expect(verifyHostDescriptor(signed, TOKEN)).toEqual(descriptor());

    expect(() =>
      verifyHostDescriptor({ ...signed, appServerPid: signed.appServerPid + 1 }, TOKEN),
    ).toThrowError(expect.objectContaining({ code: "SIGNATURE_INVALID" }));
    expect(() => verifyHostDescriptor(signed, `${TOKEN}-different`)).toThrowError(
      expect.objectContaining({ code: "SIGNATURE_INVALID" }),
    );
    expect(() => signHostDescriptor(descriptor(), "short-token")).toThrow(HostDescriptorError);
  });

  it("atomically writes and reads a signed owner-only descriptor", async () => {
    const { directory, descriptorPath } = await workspace();
    const signed = await writeHostDescriptor(descriptorPath, descriptor(), TOKEN);
    const persisted = JSON.parse(await readFile(descriptorPath, "utf8")) as unknown;
    expect(persisted).toEqual(signed);
    expect(await readHostDescriptor(descriptorPath, TOKEN)).toEqual({
      status: "valid",
      descriptor: descriptor(),
    });

    const replacement = descriptor({
      appServerPid: 6789,
      hostNonce: "replacement-host-nonce-123456",
    });
    await writeHostDescriptor(descriptorPath, replacement, TOKEN);
    expect(await readHostDescriptor(descriptorPath, TOKEN)).toEqual({
      status: "valid",
      descriptor: replacement,
    });
    expect((await readdir(directory)).filter((name) => name.includes(".pending."))).toEqual([]);
    if (process.platform !== "win32") {
      expect((await stat(descriptorPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("returns missing without creating filesystem state", async () => {
    const { directory, descriptorPath } = await workspace();
    expect(await readHostDescriptor(descriptorPath, TOKEN)).toEqual({ status: "missing" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("quarantines malformed JSON and structurally corrupt descriptors", async () => {
    const { directory, descriptorPath } = await workspace();
    await writeFile(descriptorPath, "{bad json", "utf8");
    const malformed = await readHostDescriptor(descriptorPath, TOKEN);
    expect(malformed).toMatchObject({
      status: "invalid",
      error: { code: "DESCRIPTOR_INVALID" },
    });
    expect(malformed.status === "invalid" ? malformed.quarantinedPath : null).toContain(
      ".corrupt.",
    );

    await writeFile(descriptorPath, JSON.stringify({ schemaVersion: 3, url: "ws://localhost" }));
    const incomplete = await readHostDescriptor(descriptorPath, TOKEN);
    expect(incomplete).toMatchObject({
      status: "invalid",
      error: { code: "DESCRIPTOR_INVALID" },
    });
    expect((await readdir(directory)).filter((name) => name.includes(".corrupt."))).toHaveLength(2);
  });

  it("does not quarantine incompatible or unauthenticated descriptors", async () => {
    const { descriptorPath } = await workspace();
    await writeFile(descriptorPath, JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect(await readHostDescriptor(descriptorPath, TOKEN)).toMatchObject({
      status: "invalid",
      error: { code: "DESCRIPTOR_INCOMPATIBLE" },
      quarantinedPath: null,
    });
    expect(await readFile(descriptorPath, "utf8")).toContain('"schemaVersion":1');

    await writeHostDescriptor(descriptorPath, descriptor(), TOKEN);
    expect(await readHostDescriptor(descriptorPath, `${TOKEN}-wrong`)).toMatchObject({
      status: "invalid",
      error: { code: "SIGNATURE_INVALID" },
      quarantinedPath: null,
    });
    expect(await stat(descriptorPath)).toBeDefined();
  });

  it("removes only the descriptor authenticated with the expected host nonce", async () => {
    const { descriptorPath } = await workspace();
    await writeHostDescriptor(descriptorPath, descriptor(), TOKEN);

    expect(await removeHostDescriptorIfOwned(descriptorPath, "another-host-nonce", TOKEN)).toBe(
      false,
    );
    expect(await readHostDescriptor(descriptorPath, TOKEN)).toMatchObject({ status: "valid" });

    expect(await removeHostDescriptorIfOwned(descriptorPath, descriptor().hostNonce, TOKEN)).toBe(
      true,
    );
    expect(await readHostDescriptor(descriptorPath, TOKEN)).toEqual({ status: "missing" });
    expect(await removeHostDescriptorIfOwned(descriptorPath, descriptor().hostNonce, TOKEN)).toBe(
      false,
    );
  });

  it("restores a descriptor when removal cannot authenticate it", async () => {
    const { descriptorPath } = await workspace();
    await writeHostDescriptor(descriptorPath, descriptor(), TOKEN);
    await chmod(descriptorPath, 0o600);

    await expect(
      removeHostDescriptorIfOwned(descriptorPath, descriptor().hostNonce, `${TOKEN}-wrong`),
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    expect(await readHostDescriptor(descriptorPath, TOKEN)).toMatchObject({ status: "valid" });
  });
});
