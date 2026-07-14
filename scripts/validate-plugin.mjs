import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "codex-inter-agent-messaging");
const manifest = JSON.parse(
  await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
);
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const marketplace = JSON.parse(
  await readFile(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"),
);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(absolute)));
    else result.push(absolute);
  }
  return result;
}

requireValue(manifest.name === "codex-inter-agent-messaging", "plugin name is invalid");
requireValue(
  /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version),
  "plugin version is not semver",
);
requireValue(manifest.version === packageJson.version, "plugin and package versions differ");
requireValue(
  typeof manifest.description === "string" && manifest.description.length > 10,
  "plugin description is missing",
);
requireValue(typeof manifest.author?.name === "string", "plugin author is missing");
requireValue(manifest.mcpServers === "./.mcp.json", "plugin MCP path is invalid");
requireValue(!("hooks" in manifest), "unsupported hooks manifest field is present");
for (const key of [
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
]) {
  requireValue(typeof manifest.interface?.[key] === "string", `plugin interface.${key} is missing`);
}
const mcp = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
const server = mcp.mcpServers?.["codex-inter-agent-messaging"];
requireValue(server?.command === "node", "plugin MCP command must be relocatable node");
requireValue(server?.cwd === ".", "plugin MCP cwd must be the plugin root");
requireValue(
  Array.isArray(server?.args) && server.args[0] === "./runtime/dist/messaging/mcp_server.js",
  "plugin MCP entrypoint is invalid",
);
for (const value of [server.command, ...(server.args ?? []), server.cwd]) {
  requireValue(
    typeof value === "string" && !path.isAbsolute(value),
    "plugin MCP config contains an absolute path",
  );
}
requireValue(
  marketplace.plugins?.some(
    (entry) =>
      entry.name === manifest.name &&
      entry.source?.source === "local" &&
      entry.source?.path === "./plugins/codex-inter-agent-messaging" &&
      entry.policy?.installation === "AVAILABLE" &&
      entry.policy?.authentication === "ON_INSTALL",
  ),
  "repository marketplace entry is invalid",
);
await access(path.join(pluginRoot, "README.md"));
await access(path.join(pluginRoot, "runtime", "dist", "messaging", "mcp_server.js"));
await access(path.join(pluginRoot, "runtime", "node_modules", "better-sqlite3"));

const packagedFiles = await filesUnder(pluginRoot);
const forbiddenNames = new Set([
  ".env",
  "app-server.token",
  "bootstrap.lock",
  "bridge.sqlite3",
  "bridge.sqlite3-shm",
  "bridge.sqlite3-wal",
  "connection.json",
  "host.log",
]);
for (const filename of packagedFiles) {
  const relative = path.relative(pluginRoot, filename).replaceAll("\\", "/");
  requireValue(
    !forbiddenNames.has(path.basename(filename)),
    `forbidden live file packaged: ${relative}`,
  );
  requireValue(
    !/\.(?:db|sqlite|sqlite3|log)$/iu.test(filename),
    `state/log file packaged: ${relative}`,
  );
  if (/\.(?:json|js|mjs|md|toml|yaml|yml)$/iu.test(filename)) {
    const text = await readFile(filename, "utf8");
    requireValue(!/[A-Za-z]:\\Users\\/u.test(text), `Windows user path packaged: ${relative}`);
    requireValue(!/(?:^|["'])\/Users\//mu.test(text), `macOS user path packaged: ${relative}`);
    requireValue(!/(?:^|["'])\/home\//mu.test(text), `Linux user path packaged: ${relative}`);
  }
}
process.stdout.write(`Plugin metadata validated: ${manifest.name} ${manifest.version}\n`);
