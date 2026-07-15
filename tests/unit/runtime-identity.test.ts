import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimeIdentity } from "../../src/app_server/identity.js";
import { loadConfig } from "../../src/config/index.js";

describe("runtime identity", () => {
  it("atomically converges simultaneous first-run callers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "runtime-identity-race-"));
    try {
      const config = loadConfig({ BRIDGE_DATA_DIRECTORY: directory });
      const identities = await Promise.all(
        Array.from({ length: 20 }, () => resolveRuntimeIdentity(config)),
      );
      expect(new Set(identities.map((identity) => identity.installationId)).size).toBe(1);
      expect((await readFile(path.join(directory, "installation.id"), "utf8")).trim()).toBe(
        identities[0]?.installationId,
      );
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
