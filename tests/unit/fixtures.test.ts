import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/app-server",
);

describe("app-server fixture inventory", () => {
  it("contains parseable response, error, notification, and tool-call examples", async () => {
    const initialize = await readFile(path.join(fixtureRoot, "initialize-response.json"), "utf8");
    const error = await readFile(path.join(fixtureRoot, "error-response.json"), "utf8");
    const toolCall = await readFile(path.join(fixtureRoot, "tool-call.json"), "utf8");
    const notifications = (await readFile(path.join(fixtureRoot, "notifications.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/);

    for (const document of [initialize, error, toolCall, ...notifications]) {
      expect(() => JSON.parse(document) as unknown).not.toThrow();
    }
    expect(initialize).toContain('"name": "codex-app-server"');
    expect(error).toContain('"code": -32600');
    expect(toolCall).toContain('"method": "item/tool/call"');
    expect(notifications.join("\n")).toContain('"method":"turn/completed"');
  });

  it("contains deliberately malformed JSONL", async () => {
    const lines = (await readFile(path.join(fixtureRoot, "malformed.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/);
    expect(
      lines.some((line) => {
        try {
          JSON.parse(line);
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
  });
});
