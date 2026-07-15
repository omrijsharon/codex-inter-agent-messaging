import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wizard = path.join(root, "scripts", "install-wizard.ps1");
const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-installer-gui-tests-"));
const codexHome = path.join(temporaryRoot, "Codex data Ω with spaces");

function runWizard(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        wizard,
        "-TestMode",
        "-RepositoryRoot",
        root,
        ...arguments_,
      ],
      {
        cwd: root,
        env: { ...process.env, CODEX_HOME: codexHome },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function readReport(name) {
  return JSON.parse(await readFile(path.join(temporaryRoot, name), "utf8"));
}

let operationError;
let cleanupError;
try {
  await mkdir(codexHome, { recursive: true });

  const cancelReport = path.join(temporaryRoot, "cancel.json");
  const cancelled = await runWizard(["-AutoCloseMilliseconds", "650", "-ReportPath", cancelReport]);
  assert.equal(cancelled.code, 2, cancelled.stderr || cancelled.stdout);
  const cancelState = await readReport("cancel.json");
  assert.equal(cancelState.state, "cancelled");
  assert.equal(cancelState.setupVisible, "Visible");
  assert.equal(cancelState.codexHome, codexHome);
  assert.match(cancelState.codexExecutable, /codex\.exe$/u);

  const successReport = path.join(temporaryRoot, "success.json");
  const succeeded = await runWizard([
    "-TestOutcome",
    "success",
    "-AutoStart",
    "-AutoCloseMilliseconds",
    "1100",
    "-ReportPath",
    successReport,
  ]);
  assert.equal(succeeded.code, 0, succeeded.stderr || succeeded.stdout);
  const successState = await readReport("success.json");
  assert.equal(successState.state, "complete");
  assert.equal(successState.finishVisible, "Visible");
  assert.equal(successState.finishTitle, "Installation complete");

  const failureReport = path.join(temporaryRoot, "failure.json");
  const failed = await runWizard([
    "-TestOutcome",
    "failure",
    "-AutoStart",
    "-AutoCloseMilliseconds",
    "1100",
    "-ReportPath",
    failureReport,
  ]);
  assert.equal(failed.code, 1, failed.stderr || failed.stdout);
  const failureState = await readReport("failure.json");
  assert.equal(failureState.state, "failed");
  assert.equal(failureState.finishVisible, "Visible");
  assert.equal(failureState.failureDetailsVisible, "Visible");

  process.stdout.write(
    `${JSON.stringify({ status: "passed", scenarios: ["visible-launch-and-cancel", "success-state", "failure-state", "custom-codex-home"] })}\n`,
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
