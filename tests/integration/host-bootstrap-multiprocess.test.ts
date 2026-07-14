import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function worker(dataDirectory: string): Promise<{ reused: boolean; hostNonce: string }> {
  const fixture = fileURLToPath(new URL("../fixtures/bootstrap-worker.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", fixture, dataDirectory], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  if (code !== 0) throw new Error(`bootstrap worker failed (${code}): ${stderr}`);
  return JSON.parse(stdout.trim()) as { reused: boolean; hostNonce: string };
}

describe("multi-process host bootstrap", () => {
  it("converges independent MCP-compatible processes on one filesystem-locked host", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "bridge-bootstrap-process-"));
    temporary.push(dataDirectory);
    const results = await Promise.all([
      worker(dataDirectory),
      worker(dataDirectory),
      worker(dataDirectory),
    ]);
    const launches = (await readFile(path.join(dataDirectory, "fake-launches.ndjson"), "utf8"))
      .trim()
      .split(/\r?\n/u);
    expect(launches).toHaveLength(1);
    expect(new Set(results.map((result) => result.hostNonce)).size).toBe(1);
    expect(results.filter((result) => !result.reused)).toHaveLength(1);

    const later = await worker(dataDirectory);
    expect(later).toMatchObject({ reused: true, hostNonce: results[0]?.hostNonce });
    expect(
      (await readFile(path.join(dataDirectory, "fake-launches.ndjson"), "utf8"))
        .trim()
        .split(/\r?\n/u),
    ).toHaveLength(1);
  }, 30_000);
});
