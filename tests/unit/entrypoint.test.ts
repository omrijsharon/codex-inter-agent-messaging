import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isMainModule } from "../../src/entrypoint.js";

describe("isMainModule", () => {
  it("matches exact and filesystem-equivalent executable paths", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "entrypoint-identity-"));
    try {
      const original = path.join(directory, "original Ω executable.js");
      const linked = path.join(directory, "linked executable with spaces.js");
      const different = path.join(directory, "different.js");
      await writeFile(original, "export {};\n", "utf8");
      await link(original, linked);
      await writeFile(different, "export {};\n", "utf8");

      const moduleUrl = pathToFileURL(original).href;
      expect(isMainModule(moduleUrl, original)).toBe(true);
      expect(isMainModule(moduleUrl, linked)).toBe(true);
      expect(isMainModule(moduleUrl, different)).toBe(false);
      expect(isMainModule(moduleUrl, path.join(directory, "missing.js"))).toBe(false);
      expect(isMainModule(moduleUrl, undefined)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
