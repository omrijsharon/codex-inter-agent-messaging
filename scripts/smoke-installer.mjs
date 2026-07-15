import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "scripts", "install-plugin.ps1");
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-installer-smoke-"));
const codexHome = path.join(temporaryRoot, "Codex home Ω with spaces");
const npmPrefix = path.join(temporaryRoot, "npm prefix Ω with spaces");
const npmCache = path.join(temporaryRoot, "npm cache Ω with spaces");
const localAppData = path.join(temporaryRoot, "local app data with spaces");
const nodeDirectory = path.dirname(process.execPath);
const isolatedPath = [
  nodeDirectory,
  path.join(systemRoot, "System32"),
  systemRoot,
  path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
].join(path.delimiter);
const environment = {
  ...process.env,
  CODEX_HOME: codexHome,
  NPM_CONFIG_PREFIX: npmPrefix,
  NPM_CONFIG_CACHE: npmCache,
  LOCALAPPDATA: localAppData,
  PATH: isolatedPath,
};

function run(file, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, arguments_, {
      cwd: options.cwd ?? root,
      env: options.env ?? environment,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function install() {
  const result = await run(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installer,
    "-Json",
    "-InstallCodexCli",
  ]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

async function runWindowsCommand(file, arguments_) {
  if (path.extname(file).toLowerCase() === ".cmd") {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const command = `& ${[file, ...arguments_].map(quote).join(" ")}; exit $LASTEXITCODE`;
    return run(powershell, ["-NoLogo", "-NoProfile", "-Command", command]);
  }
  return run(file, arguments_);
}

async function findRuntimeArtifacts(directory) {
  const found = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (
        /^(?:connection\.json|bootstrap\.lock)$/iu.test(entry.name) ||
        /\.(?:sqlite3?|log|tgz)$/iu.test(entry.name)
      ) {
        found.push(absolute);
      }
    }
  }
  await visit(directory);
  return found;
}

async function removeIsolatedInstallFromUserPath() {
  const visibleBin = path.join(localAppData, "Programs", "OpenAI", "Codex", "bin");
  const cleanupScript = [
    "$target=$env:CODEX_SMOKE_VISIBLE_BIN",
    "$current=[Environment]::GetEnvironmentVariable('Path','User')",
    "$kept=@(($current -split ';') | Where-Object { -not [string]::Equals($_,$target,[StringComparison]::OrdinalIgnoreCase) })",
    "[Environment]::SetEnvironmentVariable('Path',($kept -join ';'),'User')",
  ].join("; ");
  return run(powershell, ["-NoLogo", "-NoProfile", "-Command", cleanupScript], {
    env: { ...environment, CODEX_SMOKE_VISIBLE_BIN: visibleBin },
  });
}

let operationError;
let cleanupError;
let summary;
try {
  await mkdir(codexHome, { recursive: true });
  await mkdir(npmPrefix, { recursive: true });
  await mkdir(npmCache, { recursive: true });
  await mkdir(localAppData, { recursive: true });
  const first = await install();
  assert.equal(first.status, "passed");
  assert.equal(first.mode, "install");
  assert.equal(first.marketplaceAlreadyAdded, false);
  assert.equal(first.plugin, "codex-inter-agent-messaging@codex-inter-agent-local");
  assert.equal(first.completedSteps.length, 7);
  assert.match(first.codexExecutable, /Programs\\OpenAI\\Codex\\bin\\codex\.exe$/u);
  await access(
    path.join(first.pluginInstalledPath, "runtime", "dist", "messaging", "mcp_server.js"),
  );

  const second = await install();
  assert.equal(second.status, "passed");
  assert.equal(second.marketplaceAlreadyAdded, true);
  assert.equal(second.pluginInstalledPath, first.pluginInstalledPath);
  assert.equal(second.completedSteps.length, 6);

  const marketplaceList = await run(first.codexExecutable, ["plugin", "marketplace", "list"]);
  assert.equal(marketplaceList.code, 0, marketplaceList.stderr);
  assert.match(marketplaceList.stdout, /codex-inter-agent-local/u);

  const pluginList = await run(first.codexExecutable, ["plugin", "list"]);
  assert.equal(pluginList.code, 0, pluginList.stderr);
  assert.match(pluginList.stdout, /codex-inter-agent-messaging@codex-inter-agent-local/u);
  assert.match(pluginList.stdout, /installed, enabled/u);

  const cliVersion = await runWindowsCommand(first.cliPath, ["--version"]);
  assert.equal(cliVersion.code, 0, cliVersion.stderr || cliVersion.stdout);
  assert.match(`${cliVersion.stdout}\n${cliVersion.stderr}`, /0\.4\.0/u);
  const cliHelp = await runWindowsCommand(first.cliPath, ["--help"]);
  assert.equal(cliHelp.code, 0, cliHelp.stderr || cliHelp.stdout);
  assert.match(`${cliHelp.stdout}\n${cliHelp.stderr}`, /connect/u);

  const runtimeArtifacts = await findRuntimeArtifacts(codexHome);
  assert.deepEqual(runtimeArtifacts, []);
  summary = {
    status: "passed",
    firstInstall: true,
    idempotentRefresh: true,
    officialCliRecovery: true,
    pluginEnabled: true,
    cliVersion: first.cliVersion,
    isolatedPath: "<temporary path with spaces and Unicode>",
    cleanup: "clean",
  };
} catch (error) {
  operationError = error;
} finally {
  try {
    const pathCleanup = await removeIsolatedInstallFromUserPath();
    assert.equal(pathCleanup.code, 0, pathCleanup.stderr || pathCleanup.stdout);
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
}

if (operationError) throw operationError;
if (cleanupError) throw cleanupError;
await assert.rejects(access(temporaryRoot), { code: "ENOENT" });
process.stdout.write(`${JSON.stringify(summary)}\n`);
