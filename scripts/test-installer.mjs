import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "scripts", "install-plugin.ps1");
const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const commandPrompt = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-installer-tests-"));
let publicCodexPath;

function run(file, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, arguments_, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
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

async function runInstaller(arguments_, environment = {}) {
  const effectiveArguments =
    publicCodexPath &&
    !arguments_.includes("-CodexExecutable") &&
    !arguments_.includes("-InstallCodexCli")
      ? [...arguments_, "-CodexExecutable", publicCodexPath]
      : arguments_;
  return run(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installer,
      ...effectiveArguments,
    ],
    { env: { ...process.env, ...environment } },
  );
}

function parseJson(output) {
  return JSON.parse(output.trim());
}

let operationError;
let cleanupError;
try {
  const whereCodex = await run("where.exe", ["codex"]);
  assert.equal(whereCodex.code, 0, whereCodex.stderr || whereCodex.stdout);
  const sourceCodex = whereCodex.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0);
  assert.ok(sourceCodex);
  publicCodexPath = path.join(temporaryRoot, "public Codex CLI Ω", "codex.exe");
  await mkdir(path.dirname(publicCodexPath), { recursive: true });
  await cp(sourceCodex.trim(), publicCodexPath);

  const isolatedCodexHome = path.join(temporaryRoot, "dry-run codex home");
  await mkdir(isolatedCodexHome, { recursive: true });
  const normal = await runInstaller(["-DryRun", "-Json"], { CODEX_HOME: isolatedCodexHome });
  assert.equal(normal.code, 0, normal.stderr || normal.stdout);
  const normalResult = parseJson(normal.stdout);
  assert.equal(normalResult.status, "passed");
  assert.equal(normalResult.mode, "dry-run");
  assert.equal(normalResult.changesMade, false);
  assert.equal(normalResult.commands.length, 6);
  assert.equal(normalResult.codexExecutable, publicCodexPath);
  assert.equal(normalResult.codexHome, isolatedCodexHome);

  const unicodeRoot = path.join(temporaryRoot, "Downloaded Ω repository with spaces");
  const unicodeCodexHome = path.join(temporaryRoot, "unicode codex home");
  await mkdir(unicodeCodexHome, { recursive: true });
  for (const relative of [
    "package.json",
    "package-lock.json",
    ".agents/plugins/marketplace.json",
    "plugins/codex-inter-agent-messaging/.codex-plugin/plugin.json",
    "scripts/build-plugin.mjs",
    "scripts/validate-plugin.mjs",
    "generated/codex/manifest.json",
  ]) {
    const destination = path.join(unicodeRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(root, relative), destination);
  }
  const unicode = await runInstaller(["-DryRun", "-Json", "-RepositoryRoot", unicodeRoot], {
    CODEX_HOME: unicodeCodexHome,
  });
  assert.equal(unicode.code, 0, unicode.stderr || unicode.stdout);
  assert.equal(parseJson(unicode.stdout).repositoryRoot, unicodeRoot);

  const conflictCodexHome = path.join(temporaryRoot, "conflict codex home");
  await mkdir(conflictCodexHome, { recursive: true });
  const conflictMarketplace = await run(
    "codex",
    ["plugin", "marketplace", "add", unicodeRoot, "--json"],
    { env: { ...process.env, CODEX_HOME: conflictCodexHome } },
  );
  assert.equal(
    conflictMarketplace.code,
    0,
    conflictMarketplace.stderr || conflictMarketplace.stdout,
  );
  const conflict = await runInstaller(["-DryRun", "-Json"], {
    CODEX_HOME: conflictCodexHome,
  });
  assert.equal(conflict.code, 1);
  const conflictResult = parseJson(conflict.stdout);
  assert.match(conflictResult.error, /already configured/u);
  assert.match(conflictResult.error, /will not replace/u);

  const emptyPath = path.join(temporaryRoot, "empty path");
  const missingCodexHome = path.join(temporaryRoot, "missing codex home");
  await mkdir(emptyPath, { recursive: true });
  await mkdir(missingCodexHome, { recursive: true });
  const missing = await runInstaller(["-DryRun", "-Json"], {
    CODEX_HOME: missingCodexHome,
    PATH: emptyPath,
  });
  assert.equal(missing.code, 1);
  const missingResult = parseJson(missing.stdout);
  assert.equal(missingResult.status, "failed");
  assert.match(missingResult.error, /Required command 'node'/u);

  const explorerCodexHome = path.join(temporaryRoot, "desktop-only codex home");
  await mkdir(explorerCodexHome, { recursive: true });
  const nodeDirectory = path.dirname(process.execPath);
  const explorerPath = [
    nodeDirectory,
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
    process.env.SystemRoot ?? "C:\\Windows",
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0"),
  ].join(path.delimiter);
  const recoveryPlan = await runInstaller(
    ["-DryRun", "-Json", "-InstallCodexCli", "-CodexHome", explorerCodexHome],
    { PATH: explorerPath, LOCALAPPDATA: path.join(temporaryRoot, "local app data") },
  );
  assert.equal(recoveryPlan.code, 0, recoveryPlan.stderr || recoveryPlan.stdout);
  const recoveryResult = parseJson(recoveryPlan.stdout);
  assert.equal(recoveryResult.officialCliInstallPlanned, true);
  assert.equal(recoveryResult.commands.length, 7);
  assert.match(recoveryResult.codexExecutable, /Programs\\OpenAI\\Codex\\bin\\codex\.exe$/u);

  const privateSelection = await runInstaller(
    [
      "-DryRun",
      "-Json",
      "-CodexExecutable",
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__id\\app\\resources\\codex.exe",
    ],
    { CODEX_HOME: isolatedCodexHome },
  );
  assert.equal(privateSelection.code, 1);
  assert.match(parseJson(privateSelection.stdout).error, /does not exist|private/u);

  const shimDirectory = path.join(temporaryRoot, "command shims");
  const shimPrefix = path.join(temporaryRoot, "shim npm prefix");
  const failureCodexHome = path.join(temporaryRoot, "failure codex home");
  await mkdir(shimDirectory, { recursive: true });
  await mkdir(failureCodexHome, { recursive: true });
  await writeFile(
    path.join(shimDirectory, "node.cmd"),
    "@echo off\r\necho v22.11.0\r\nexit /b 0\r\n",
    "utf8",
  );
  await writeFile(
    path.join(shimDirectory, "npm.cmd"),
    `@echo off\r\nif "%1"=="--version" (echo 10.9.0& exit /b 0)\r\nif "%1"=="prefix" (echo ${shimPrefix}& exit /b 0)\r\nexit /b 23\r\n`,
    "utf8",
  );
  await writeFile(
    path.join(shimDirectory, "codex.cmd"),
    '@echo off\r\nif "%1"=="--version" (echo codex-cli 0.144.2& exit /b 0)\r\nif "%1"=="plugin" if "%2"=="--help" (echo Manage Codex plugins& exit /b 0)\r\nif "%1"=="plugin" if "%2"=="marketplace" if "%3"=="list" (exit /b 0)\r\nexit /b 31\r\n',
    "utf8",
  );
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const shimPath = [
    shimDirectory,
    path.join(systemRoot, "System32"),
    systemRoot,
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(path.delimiter);
  const failedCommand = await runInstaller(["-Json"], {
    CODEX_HOME: failureCodexHome,
    PATH: shimPath,
  });
  assert.equal(failedCommand.code, 1);
  const failedResult = parseJson(failedCommand.stdout);
  assert.equal(failedResult.step, "Install locked dependencies");
  assert.match(failedResult.error, /exit code 23/u);

  const batch = await readFile(path.join(root, "INSTALL.cmd"), "utf8");
  assert.match(batch, /scripts\\install-wizard\.ps1/u);
  assert.match(batch, /if "%~1"==""/u);
  assert.match(batch, /-HideConsole/u);
  assert.doesNotMatch(batch, /-WindowStyle Hidden/u);
  assert.match(batch, /%~dp0scripts\\install-plugin\.ps1/u);
  assert.match(batch, /INSTALL_EXIT_CODE=%ERRORLEVEL%/u);
  assert.match(batch, /exit \/b %INSTALL_EXIT_CODE%/u);
  const batchCodexHome = path.join(temporaryRoot, "batch codex home");
  await mkdir(batchCodexHome, { recursive: true });
  const batchRun = await run(
    commandPrompt,
    ["/d", "/c", "INSTALL.cmd", "-DryRun", "-Json", "-CodexExecutable", publicCodexPath],
    {
      env: {
        ...process.env,
        CODEX_HOME: batchCodexHome,
        CODEX_INTER_AGENT_INSTALL_NO_PAUSE: "1",
      },
    },
  );
  assert.equal(batchRun.code, 0, batchRun.stderr || batchRun.stdout);
  assert.match(batchRun.stdout, /"status":\s+"passed"/u);
  assert.match(batchRun.stdout, /Installer finished successfully/u);

  process.stdout.write(
    `${JSON.stringify({ status: "passed", scenarios: ["dry-run", "unicode-path", "marketplace-conflict", "missing-prerequisite", "desktop-only-recovery-plan", "private-binary-rejection", "command-failure", "batch-entrypoint"] })}\n`,
  );
} catch (error) {
  operationError = error;
} finally {
  try {
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
}

if (operationError) throw operationError;
if (cleanupError) throw cleanupError;
