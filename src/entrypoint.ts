import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Return true when argvPath and importMetaUrl identify the same executable file. */
export function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(importMetaUrl);
  try {
    const moduleStat = statSync(modulePath);
    const argumentStat = statSync(argvPath);
    if (
      moduleStat.ino !== 0 &&
      moduleStat.dev === argumentStat.dev &&
      moduleStat.ino === argumentStat.ino
    ) {
      return true;
    }
  } catch {
    // Fall through to spelling comparison so a missing argv path remains a normal non-entrypoint.
  }
  return normalizedPath(modulePath) === normalizedPath(argvPath);
}
