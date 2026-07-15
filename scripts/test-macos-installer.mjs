import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(root, "scripts", "install-plugin-macos.sh");
const wizard = path.join(root, "scripts", "install-wizard-macos.sh");
const launcher = path.join(root, "INSTALL.command");
const builder = path.join(root, "scripts", "build-macos-installer.sh");
const staticOnly = process.argv.includes("--static") || process.platform !== "darwin";

for (const filename of [backend, wizard, launcher, builder]) {
  const text = await readFile(filename, "utf8");
  assert.match(text, /^#!\/bin\/bash/u, `${filename} must have a Bash shebang`);
  assert.equal(text.includes("\r\n"), false, `${filename} must use Unix line endings`);
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const infoPlist = await readFile(path.join(root, "installer", "macos", "Info.plist"), "utf8");
assert.match(
  infoPlist,
  new RegExp(`<string>${packageJson.version.replaceAll(".", "\\.")}</string>`, "u"),
);
assert.match(await readFile(backend, "utf8"), /CODEX_RELEASE="\$supported_codex_version"/u);
assert.match(
  await readFile(backend, "utf8"),
  /Library\/Application Support\/Codex Inter-Agent Messaging/u,
);
assert.doesNotMatch(await readFile(backend, "utf8"), /sudo/u);

if (staticOnly) {
  process.stdout.write(
    "macOS installer static contract: passed (runtime scenarios require macOS)\n",
  );
  process.exit(0);
}

for (const filename of [backend, wizard, launcher, builder]) {
  assert.ok((await stat(filename)).mode & 0o100, `${filename} must be executable`);
}

const temp = await mkdtemp(path.join(os.tmpdir(), "codex-inter-agent-macos-test-"));
try {
  const fakeCodex = path.join(temp, "bin", "codex");
  const codexHome = path.join(temp, "Codex Home ü");
  const installRoot = path.join(temp, "Application Support", "Codex Messaging ü");
  await mkdir(path.dirname(fakeCodex), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    fakeCodex,
    `#!/bin/bash
set -euo pipefail
state="\${CODEX_HOME:?}/fake-marketplace"
plugin_state="\${CODEX_HOME:?}/fake-plugin"
if [[ "\${1:-}" == "--version" ]]; then echo "codex-cli 0.144.2"; exit 0; fi
if [[ "\${1:-}" == "plugin" && "\${2:-}" == "--help" ]]; then echo "plugin commands"; exit 0; fi
if [[ "\${1:-}" == "plugin" && "\${2:-}" == "marketplace" && "\${3:-}" == "list" ]]; then
  [[ -f "$state" ]] && printf 'codex-inter-agent-local %s\\n' "$(cat "$state")"
  exit 0
fi
if [[ "\${1:-}" == "plugin" && "\${2:-}" == "marketplace" && "\${3:-}" == "add" ]]; then
  printf '%s' "$4" > "$state"; printf '{"alreadyAdded":false}\\n'; exit 0
fi
if [[ "\${1:-}" == "plugin" && "\${2:-}" == "add" ]]; then
  printf '%s' "$3" > "$plugin_state"; printf '{"version":"0.4.0"}\\n'; exit 0
fi
if [[ "\${1:-}" == "plugin" && "\${2:-}" == "list" ]]; then
  [[ -f "$plugin_state" ]] && printf '%s installed, enabled\\n' "$(cat "$plugin_state")"
  exit 0
fi
echo "unexpected fake codex command: $*" >&2; exit 40
`,
  );
  await chmod(fakeCodex, 0o755);

  const common = [
    backend,
    "--repository-root",
    root,
    "--codex-executable",
    fakeCodex,
    "--codex-home",
    codexHome,
    "--install-root",
    installRoot,
  ];
  const dry = JSON.parse(
    execFileSync("/bin/bash", [...common, "--dry-run", "--json"], { encoding: "utf8" }),
  );
  assert.equal(dry.status, "passed");
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.changesMade, false);
  assert.equal(dry.supportedCodexVersion, "0.144.2");
  assert.equal(dry.durableSource, path.join(installRoot, "source"));

  const wizardState = JSON.parse(
    execFileSync("/bin/bash", [wizard, "--repository-root", root], {
      encoding: "utf8",
      env: { ...process.env, INTER_AGENT_INSTALLER_TEST_MODE: "1" },
    }),
  );
  assert.equal(wizardState.status, "ready");

  const privateRoot = path.join(temp, "Codex.app", "Contents", "Resources");
  await mkdir(privateRoot, { recursive: true });
  const privateCodex = path.join(privateRoot, "codex");
  await writeFile(privateCodex, "#!/bin/bash\nexit 0\n");
  await chmod(privateCodex, 0o755);
  const rejected = spawnSync(
    "/bin/bash",
    [
      backend,
      "--repository-root",
      root,
      "--codex-executable",
      privateCodex,
      "--codex-home",
      codexHome,
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /private to Codex\.app/u);

  const conflictingHome = path.join(temp, "conflicting-home");
  await mkdir(conflictingHome, { recursive: true });
  await writeFile(path.join(conflictingHome, "fake-marketplace"), "/another/repository");
  const collision = spawnSync(
    "/bin/bash",
    [
      backend,
      "--repository-root",
      root,
      "--codex-executable",
      fakeCodex,
      "--codex-home",
      conflictingHome,
      "--install-root",
      installRoot,
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(collision.status, 0);
  assert.match(`${collision.stdout}${collision.stderr}`, /will not rebind/u);

  process.stdout.write(
    "macOS installer tests: 5 scenarios passed (static, dry-run, wizard, private CLI, collision)\n",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
