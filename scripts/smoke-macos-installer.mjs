import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.stderr.write("smoke:installer:macos requires macOS\n");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(root, "scripts", "install-plugin-macos.sh");
const protocol = JSON.parse(
  await import(path.join(root, "generated", "codex", "manifest.json"), {
    with: { type: "json" },
  }).then((m) => JSON.stringify(m.default)),
);
const expectedCodex = protocol.codexVersion.match(/[0-9]+\.[0-9]+\.[0-9]+/u)[0];
const codex = process.env.MACOS_SMOKE_CODEX;
if (!codex) throw new Error("MACOS_SMOKE_CODEX must name the manifest-pinned public Codex CLI");

const temp = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-macos-smoke-"));
const home = path.join(temp, "User Home ü");
const codexHome = path.join(home, ".codex");
const installRoot = path.join(
  home,
  "Library",
  "Application Support",
  "Codex Inter-Agent Messaging",
);
await mkdir(codexHome, { recursive: true });

try {
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  const args = [
    backend,
    "--repository-root",
    root,
    "--codex-executable",
    codex,
    "--codex-home",
    codexHome,
    "--install-root",
    installRoot,
    "--json",
  ];
  const first = JSON.parse(
    execFileSync("/bin/bash", args, { encoding: "utf8", env, maxBuffer: 20 * 1024 * 1024 }),
  );
  const second = JSON.parse(
    execFileSync("/bin/bash", args, { encoding: "utf8", env, maxBuffer: 20 * 1024 * 1024 }),
  );
  assert.equal(first.status, "passed");
  assert.equal(second.status, "passed");
  assert.equal(first.supportedCodexVersion, expectedCodex);
  assert.equal(second.marketplaceState, "same-path");
  await access(
    path.join(
      installRoot,
      "source",
      "plugins",
      "codex-inter-agent-messaging",
      "runtime",
      "dist",
      "messaging",
      "mcp_server.js",
    ),
  );
  await access(path.join(home, ".local", "bin", "codex-inter-agent"));
  const cliVersion = execFileSync(
    path.join(home, ".local", "bin", "codex-inter-agent"),
    ["--version"],
    { encoding: "utf8", env },
  ).trim();
  assert.equal(cliVersion, "0.4.0");
  process.stdout.write(
    "macOS installer smoke: real Codex first install + refresh passed; cleanup: clean\n",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
