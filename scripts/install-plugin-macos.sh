#!/bin/bash

set -euo pipefail

MARKETPLACE_NAME="codex-inter-agent-local"
PLUGIN_NAME="codex-inter-agent-messaging"
PLUGIN_SELECTOR="$PLUGIN_NAME@$MARKETPLACE_NAME"
OFFICIAL_CODEX_INSTALLER_URL="https://chatgpt.com/codex/install.sh"
MINIMUM_NODE="22.11.0"
MINIMUM_NPM="10.9.0"

dry_run=0
json=0
install_codex_cli=0
repository_root=""
codex_executable=""
codex_home="${CODEX_HOME:-$HOME/.codex}"
install_root="$HOME/Library/Application Support/Codex Inter-Agent Messaging"
progress_path=""
current_step="Initialize installer"
staging_root=""
backup_source=""
source_swapped=0

usage() {
  cat <<'EOF'
Usage: scripts/install-plugin-macos.sh [options]

  --dry-run                    Validate and print the no-write command plan.
  --json                       Emit one machine-readable result object.
  --repository-root PATH       Source payload root (defaults to this checkout).
  --codex-executable PATH      Explicit public Codex CLI executable.
  --codex-home PATH            Codex data directory (defaults to ~/.codex).
  --install-root PATH          Durable current-user installation root.
  --install-codex-cli          Consent to install the pinned official Codex CLI.
  --progress-path PATH         Write compact progress state for a GUI wrapper.
  --help                       Show this help.
EOF
}

installer_message() {
  if [[ "$json" -eq 0 ]]; then
    printf '%s\n' "$1"
  fi
}

write_progress() {
  local state="$1"
  local message="$2"
  [[ -n "$progress_path" ]] || return 0
  PROGRESS_STATE="$state" PROGRESS_STEP="$current_step" PROGRESS_MESSAGE="$message" \
    "$node_command" -e '
      const fs = require("node:fs");
      fs.writeFileSync(process.argv[1], JSON.stringify({
        state: process.env.PROGRESS_STATE,
        step: process.env.PROGRESS_STEP,
        message: process.env.PROGRESS_MESSAGE,
        timestamp: new Date().toISOString()
      }));
    ' "$progress_path"
}

fail() {
  local message="$1"
  if [[ -n "${node_command:-}" && -n "$progress_path" ]]; then
    write_progress "failed" "$message" || true
  fi
  if [[ "$json" -eq 1 && -n "${node_command:-}" ]]; then
    RESULT_MODE="$([[ "$dry_run" -eq 1 ]] && printf dry-run || printf install)" \
      RESULT_STEP="$current_step" RESULT_ERROR="$message" "$node_command" -e '
        process.stdout.write(JSON.stringify({
          status: "failed",
          mode: process.env.RESULT_MODE,
          step: process.env.RESULT_STEP,
          error: process.env.RESULT_ERROR
        }) + "\n");
      '
  else
    printf '\nInstallation failed during: %s\n%s\n' "$current_step" "$message" >&2
  fi
  exit 1
}

cleanup() {
  local exit_code=$?
  if [[ -n "$staging_root" && -d "$staging_root" ]]; then
    rm -rf "$staging_root"
  fi
  if [[ "$exit_code" -ne 0 && "$source_swapped" -eq 1 ]]; then
    rm -rf "$install_root/source"
    if [[ -n "$backup_source" && -d "$backup_source" ]]; then
      mv "$backup_source" "$install_root/source"
    fi
  elif [[ "$exit_code" -eq 0 && -n "$backup_source" && -d "$backup_source" ]]; then
    rm -rf "$backup_source"
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --json) json=1 ;;
    --install-codex-cli) install_codex_cli=1 ;;
    --repository-root|--codex-executable|--codex-home|--install-root|--progress-path)
      [[ $# -ge 2 ]] || { printf '%s requires a value.\n' "$1" >&2; exit 2; }
      case "$1" in
        --repository-root) repository_root="$2" ;;
        --codex-executable) codex_executable="$2" ;;
        --codex-home) codex_home="$2" ;;
        --install-root) install_root="$2" ;;
        --progress-path) progress_path="$2" ;;
      esac
      shift
      ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$(uname -s)" != "Darwin" && "${INTER_AGENT_INSTALLER_ALLOW_NON_DARWIN:-0}" != "1" ]]; then
  printf 'This installer backend requires macOS. Use INSTALL.cmd on Windows.\n' >&2
  exit 1
fi

if [[ -z "$repository_root" ]]; then
  repository_root="$(cd "$(dirname "$0")/.." && pwd -P)"
else
  repository_root="$(cd "$repository_root" 2>/dev/null && pwd -P)" || {
    printf 'Repository root does not exist: %s\n' "$repository_root" >&2
    exit 1
  }
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

find_command() {
  local name="$1"
  local result=""
  result="$(command -v "$name" 2>/dev/null || true)"
  if [[ -z "$result" && -n "${SHELL:-}" && -x "${SHELL:-}" ]]; then
    result="$($SHELL -lc "command -v $name" 2>/dev/null | head -n 1 || true)"
  fi
  [[ -n "$result" ]] || return 1
  printf '%s\n' "$result"
}

node_command="$(find_command node || true)"
[[ -n "$node_command" ]] || {
  printf 'Node.js %s or newer was not found. Install Node.js, then retry.\n' "$MINIMUM_NODE" >&2
  exit 1
}
npm_command="$(find_command npm || true)"
[[ -n "$npm_command" ]] || fail "npm $MINIMUM_NPM or newer was not found. Install npm with Node.js, then retry."

current_step="Check installer payload"
required_files=(
  "package.json"
  "package-lock.json"
  "tsconfig.json"
  "tsconfig.build.json"
  ".agents/plugins/marketplace.json"
  "plugins/codex-inter-agent-messaging/.codex-plugin/plugin.json"
  "plugins/codex-inter-agent-messaging/.mcp.json"
  "scripts/build-plugin.mjs"
  "scripts/validate-plugin.mjs"
  "scripts/stage-macos-payload.sh"
  "generated/codex/manifest.json"
)
for required_file in "${required_files[@]}"; do
  [[ -f "$repository_root/$required_file" ]] || fail "Installer payload is incomplete; required file is missing: $required_file"
done
[[ -d "$repository_root/src" ]] || fail "Installer payload is incomplete; src is missing."

package_version="$($node_command -p "require(process.argv[1]).version" "$repository_root/package.json")"
supported_codex_version="$($node_command -p "require(process.argv[1]).codexVersion.match(/[0-9]+\\.[0-9]+\\.[0-9]+/)[0]" "$repository_root/generated/codex/manifest.json")"

current_step="Check prerequisites"
node_version="$($node_command --version | sed 's/^v//')"
npm_version="$($npm_command --version)"
if ! "$node_command" -e '
  const [actual, minimum] = process.argv.slice(1).map(v => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    if (actual[i] > minimum[i]) process.exit(0);
    if (actual[i] < minimum[i]) process.exit(1);
  }
' "$node_version" "$MINIMUM_NODE"; then
  fail "Node.js $node_version is unsupported. Install Node.js $MINIMUM_NODE or newer."
fi
if ! "$node_command" -e '
  const [actual, minimum] = process.argv.slice(1).map(v => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    if (actual[i] > minimum[i]) process.exit(0);
    if (actual[i] < minimum[i]) process.exit(1);
  }
' "$npm_version" "$MINIMUM_NPM"; then
  fail "npm $npm_version is unsupported. Install npm $MINIMUM_NPM or newer."
fi

parent_codex_home="$(dirname "$codex_home")"
[[ -d "$codex_home" || -d "$parent_codex_home" ]] || fail "The selected Codex data directory cannot be created because its parent does not exist: $codex_home"

is_private_codex() {
  case "$1" in
    */Codex.app/Contents/*|*/.vscode/extensions/openai.chatgpt-*/bin/*/codex*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_codex() {
  local candidate=""
  if [[ -n "$codex_executable" ]]; then
    [[ -x "$codex_executable" ]] || fail "The selected Codex CLI is not executable: $codex_executable"
    candidate="$codex_executable"
  else
    candidate="$(find_command codex || true)"
    if [[ -z "$candidate" && -x "$HOME/.local/bin/codex" ]]; then
      candidate="$HOME/.local/bin/codex"
    fi
  fi
  if [[ -n "$candidate" ]] && is_private_codex "$candidate"; then
    fail "The selected executable is private to Codex.app or an editor extension. Select a public standalone Codex CLI."
  fi
  printf '%s' "$candidate"
}

codex_command="$(resolve_codex)"
codex_install_planned=0
codex_desktop_detected=0
[[ -d "/Applications/Codex.app" || -d "$HOME/Applications/Codex.app" ]] && codex_desktop_detected=1

validate_codex() {
  local candidate="$1"
  local version_output actual
  version_output="$($candidate --version 2>&1)" || return 1
  "$candidate" plugin --help >/dev/null 2>&1 || return 1
  actual="$(printf '%s' "$version_output" | sed -nE 's/.*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1)"
  [[ "$actual" == "$supported_codex_version" ]]
}

if [[ -z "$codex_command" ]] || ! validate_codex "$codex_command"; then
  if [[ "$install_codex_cli" -ne 1 ]]; then
    if [[ -n "$codex_command" ]]; then
      fail "The selected Codex CLI is missing plugin support or does not match required version $supported_codex_version."
    fi
    desktop_hint=""
    [[ "$codex_desktop_detected" -eq 1 ]] && desktop_hint=" Codex.app is installed, but its packaged executable is not a public CLI."
    fail "A compatible public Codex CLI was not found.$desktop_hint Select one or consent to install official Codex CLI $supported_codex_version."
  fi
  codex_install_planned=1
  codex_command="$HOME/.local/bin/codex"
fi

configured_root=""
if [[ "$codex_install_planned" -eq 0 && -d "$codex_home" ]]; then
  marketplace_output="$(CODEX_HOME="$codex_home" "$codex_command" plugin marketplace list 2>/dev/null || true)"
  configured_root="$(printf '%s\n' "$marketplace_output" | awk -v name="$MARKETPLACE_NAME" '$1 == name { $1=""; sub(/^[[:space:]]+/, ""); print; exit }')"
fi
durable_source="$install_root/source"
if [[ -n "$configured_root" && "${configured_root%/}" != "${durable_source%/}" ]]; then
  fail "Marketplace '$MARKETPLACE_NAME' is already configured at '$configured_root'. Remove that known marketplace explicitly or use its installer; this installer will not rebind it to '$durable_source'."
fi

emit_result() {
  local mode="$1"
  local marketplace_state="$2"
  RESULT_MODE="$mode" RESULT_REPOSITORY="$repository_root" RESULT_CODEX_HOME="$codex_home" \
    RESULT_CODEX="$codex_command" RESULT_CODEX_DESKTOP="$codex_desktop_detected" \
    RESULT_CODEX_VERSION="$supported_codex_version" RESULT_CODEX_INSTALL="$codex_install_planned" \
    RESULT_INSTALL_ROOT="$install_root" RESULT_SOURCE="$durable_source" \
    RESULT_MARKETPLACE_STATE="$marketplace_state" RESULT_PLUGIN="$PLUGIN_SELECTOR" \
    RESULT_PACKAGE_VERSION="$package_version" RESULT_NODE="$node_version" RESULT_NPM="$npm_version" \
    "$node_command" -e '
      const bool = value => value === "1";
      process.stdout.write(JSON.stringify({
        status: "passed",
        mode: process.env.RESULT_MODE,
        repositoryRoot: process.env.RESULT_REPOSITORY,
        codexHome: process.env.RESULT_CODEX_HOME,
        codexExecutable: process.env.RESULT_CODEX,
        codexDesktopDetected: bool(process.env.RESULT_CODEX_DESKTOP),
        supportedCodexVersion: process.env.RESULT_CODEX_VERSION,
        officialCliInstallPlanned: bool(process.env.RESULT_CODEX_INSTALL),
        installRoot: process.env.RESULT_INSTALL_ROOT,
        durableSource: process.env.RESULT_SOURCE,
        marketplace: "codex-inter-agent-local",
        marketplaceState: process.env.RESULT_MARKETPLACE_STATE,
        plugin: process.env.RESULT_PLUGIN,
        pluginVersion: process.env.RESULT_PACKAGE_VERSION,
        versions: { node: process.env.RESULT_NODE, npm: process.env.RESULT_NPM },
        commands: [
          "stage allowlisted payload",
          "npm ci --no-audit --no-fund",
          "npm run plugin:build",
          "npm run plugin:validate",
          "install companion CLI under Application Support",
          "codex plugin marketplace add <durable-source> --json",
          "codex plugin add codex-inter-agent-messaging@codex-inter-agent-local --json"
        ],
        changesMade: process.env.RESULT_MODE !== "dry-run"
      }) + "\n");
    '
}

if [[ "$dry_run" -eq 1 ]]; then
  marketplace_state="$([[ -n "$configured_root" ]] && printf same-path || printf not-configured)"
  if [[ "$json" -eq 1 ]]; then
    emit_result "dry-run" "$marketplace_state"
  else
    installer_message "Dry run passed. No changes were made."
    installer_message "Pinned Codex CLI: $supported_codex_version"
    installer_message "Durable source: $durable_source"
    installer_message "Plugin: $PLUGIN_SELECTOR"
  fi
  write_progress "complete" "Dry run passed; no changes were made"
  exit 0
fi

mkdir -p "$codex_home" "$install_root" "$HOME/.local/bin"

if [[ "$codex_install_planned" -eq 1 ]]; then
  current_step="Install official Codex CLI"
  installer_message "Installing official Codex CLI $supported_codex_version..."
  write_progress "running" "$current_step"
  installer_tmp="$(mktemp -d "${TMPDIR:-/tmp}/codex-cli-installer.XXXXXX")"
  if ! curl -fsSL "$OFFICIAL_CODEX_INSTALLER_URL" -o "$installer_tmp/install.sh"; then
    rm -rf "$installer_tmp"
    fail "Could not download the official Codex CLI installer."
  fi
  if ! CODEX_NON_INTERACTIVE=1 CODEX_RELEASE="$supported_codex_version" \
      CODEX_INSTALL_DIR="$HOME/.local/bin" CODEX_HOME="$codex_home" \
      /bin/sh "$installer_tmp/install.sh"; then
    rm -rf "$installer_tmp"
    fail "The official Codex CLI installer failed."
  fi
  rm -rf "$installer_tmp"
  [[ -x "$codex_command" ]] || fail "The official installer completed but '$codex_command' was not created."
  validate_codex "$codex_command" || fail "The installed Codex CLI failed exact-version or plugin-command validation."
fi

current_step="Stage installer payload"
installer_message "Staging the reviewed plugin payload..."
write_progress "running" "$current_step"
staging_root="$(mktemp -d "$install_root/.stage.XXXXXX")"
staged_source="$staging_root/source"
/bin/bash "$repository_root/scripts/stage-macos-payload.sh" "$repository_root" "$staged_source"

current_step="Install locked dependencies"
installer_message "Installing locked dependencies..."
write_progress "running" "$current_step"
(cd "$staged_source" && "$npm_command" ci --no-audit --no-fund)

current_step="Build and validate plugin"
installer_message "Building and validating the plugin..."
write_progress "running" "$current_step"
(cd "$staged_source" && "$npm_command" run plugin:build && "$npm_command" run plugin:validate)

current_step="Publish durable payload"
if [[ -d "$durable_source" ]]; then
  backup_source="$install_root/.source.previous.$$"
  rm -rf "$backup_source"
  mv "$durable_source" "$backup_source"
fi
mv "$staged_source" "$durable_source"
source_swapped=1

current_step="Install companion CLI"
installer_message "Installing the companion CLI for this user..."
write_progress "running" "$current_step"
rm -rf "$install_root/cli"
"$npm_command" install --prefix "$install_root/cli" "$durable_source" --no-audit --no-fund
cli_target="$install_root/cli/node_modules/.bin/codex-inter-agent"
[[ -x "$cli_target" ]] || fail "npm completed but the companion CLI was not found at '$cli_target'."
ln -sfn "$cli_target" "$HOME/.local/bin/codex-inter-agent"
installed_cli_version="$($HOME/.local/bin/codex-inter-agent --version)"
[[ "$installed_cli_version" == "$package_version" ]] || fail "Installed CLI version '$installed_cli_version' does not match '$package_version'."

current_step="Register marketplace and plugin"
installer_message "Registering and enabling the Codex plugin..."
write_progress "running" "$current_step"
CODEX_HOME="$codex_home" "$codex_command" plugin marketplace add "$durable_source" --json >/dev/null
CODEX_HOME="$codex_home" "$codex_command" plugin add "$PLUGIN_SELECTOR" --json >/dev/null

current_step="Verify installation"
marketplace_output="$(CODEX_HOME="$codex_home" "$codex_command" plugin marketplace list)"
verified_root="$(printf '%s\n' "$marketplace_output" | awk -v name="$MARKETPLACE_NAME" '$1 == name { $1=""; sub(/^[[:space:]]+/, ""); print; exit }')"
[[ "${verified_root%/}" == "${durable_source%/}" ]] || fail "Codex did not report the expected durable marketplace path."
plugin_output="$(CODEX_HOME="$codex_home" "$codex_command" plugin list)"
[[ "$plugin_output" == *"$PLUGIN_SELECTOR"* && "$plugin_output" == *"installed, enabled"* ]] || fail "Codex did not report '$PLUGIN_SELECTOR' as installed and enabled."

source_swapped=0
[[ -n "$backup_source" && -d "$backup_source" ]] && rm -rf "$backup_source"
backup_source=""
write_progress "complete" "Installation completed successfully"

if [[ "$json" -eq 1 ]]; then
  emit_result "install" "same-path"
else
  installer_message ""
  installer_message "Installation complete."
  installer_message "Plugin: $PLUGIN_SELECTOR ($package_version)"
  installer_message "CLI: $HOME/.local/bin/codex-inter-agent"
  installer_message "Open a new Codex task, then configure trusted BRIDGE_AGENT_ID separately."
fi
