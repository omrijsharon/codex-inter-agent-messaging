import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const generatedRoot = path.join(repositoryRoot, "generated", "codex");

export function assertInsideRepository(candidate) {
  const relative = path.relative(repositoryRoot, path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path is outside repository: ${candidate}`);
  }
}

export function codexVersion() {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || "codex --version failed");
  return result.stdout.trim();
}

export function runCodex(arguments_) {
  const result = spawnSync("codex", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`codex ${arguments_.join(" ")} failed:\n${result.stderr}`);
  }
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

export async function protocolDigest(root = generatedRoot) {
  const roots = [path.join(root, "json-schema"), path.join(root, "typescript")];
  const files = (await Promise.all(roots.map(filesUnder))).flat().sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return { fileCount: files.length, sha256: hash.digest("hex") };
}
