import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/main.js";

describe("production CLI foundation", () => {
  it("runs help and version entry points", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runCli(["--help"])).resolves.toBe(0);
    await expect(runCli(["--version"])).resolves.toBe(0);
    expect(output.mock.calls.flat().join("")).toContain("codex-inter-agent 0.3.0");
    output.mockRestore();
  });
});
