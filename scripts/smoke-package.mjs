import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const directory = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-package-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable");
const expectedVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

try {
  const npm = (arguments_) => run(process.execPath, [npmCli, ...arguments_]);
  npm(["run", "clean"]);
  npm(["run", "build"]);
  const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", directory]));
  const filename = packed?.[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return an artifact name");
  const tarball = path.join(directory, filename);
  const install = path.join(directory, "install");
  npm(["install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const packageRoot = path.join(install, "node_modules", "codex-inter-agent-messaging");
  const cliHelp = run(
    process.execPath,
    [path.join(packageRoot, "dist", "cli", "main.js"), "--help"],
    { cwd: install },
  );
  const hostHelp = run(
    process.execPath,
    [path.join(packageRoot, "dist", "app_server", "main.js"), "--help"],
    { cwd: install },
  );
  if (!cliHelp.includes("Usage:") || !hostHelp.includes("Usage:")) {
    throw new Error("installed command help output is invalid");
  }
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "dist", "messaging", "mcp_server.js")).href)})`,
    ],
    { cwd: install },
  );
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (packageJson.version !== expectedVersion)
    throw new Error("installed package version is incorrect");
  const releaseRecord = await readFile(path.join(packageRoot, "RELEASES.md"), "utf8");
  if (!releaseRecord.includes(`v${expectedVersion}`)) {
    throw new Error("installed package is missing its current release record");
  }
  process.stdout.write(
    `${JSON.stringify({ status: "ok", artifact: filename, version: packageJson.version, commands: 3 })}\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
