#!/bin/bash

set -euo pipefail

repository_root=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repository-root) repository_root="$2"; shift ;;
    *) printf 'Unknown wizard option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n "$repository_root" ]] || repository_root="$(cd "$(dirname "$0")/.." && pwd -P)"
backend="$repository_root/scripts/install-plugin-macos.sh"

if [[ "${INTER_AGENT_INSTALLER_TEST_MODE:-0}" == "1" ]]; then
  printf '{"status":"ready","surface":"macos-source-wizard","repositoryRoot":"%s"}\n' "$repository_root"
  exit 0
fi

choice="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set response to display dialog "Install Codex Inter-Agent Messaging for this macOS user.\n\nThe installer adds the local Codex plugin and companion CLI. It does not register agents, choose identities, or change task histories." buttons {"Cancel", "Continue"} default button "Continue" cancel button "Cancel" with title "Codex Inter-Agent Messaging Installer"
  return button returned of response
end tell
APPLESCRIPT
)" || exit 0
[[ "$choice" == "Continue" ]] || exit 0

codex_home="$(osascript - "$HOME/.codex" <<'APPLESCRIPT'
on run argv
  tell application "System Events"
    activate
    set defaultPath to POSIX file (item 1 of argv)
    try
      set selectedFolder to choose folder with prompt "Choose the Codex data directory" default location defaultPath
    on error
      set selectedFolder to choose folder with prompt "Choose the Codex data directory"
    end try
    return POSIX path of selectedFolder
  end tell
end run
APPLESCRIPT
)" || exit 0
codex_home="${codex_home%/}"

cli_choice="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set response to display dialog "Use an existing public Codex CLI, or let the installer auto-detect one?\n\nCodex.app's private executable is not a supported CLI." buttons {"Choose CLI", "Auto-detect"} default button "Auto-detect" with title "Codex CLI"
  return button returned of response
end tell
APPLESCRIPT
)" || exit 0

codex_args=()
if [[ "$cli_choice" == "Choose CLI" ]]; then
  codex_path="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set selectedFile to choose file with prompt "Choose a public Codex CLI executable"
  return POSIX path of selectedFile
end tell
APPLESCRIPT
)" || exit 0
  codex_args=(--codex-executable "$codex_path")
fi

install_choice="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set response to display dialog "If no compatible public Codex CLI is available, may the installer download the exact supported release from OpenAI?" buttons {"No", "Yes"} default button "Yes" with title "Official Codex CLI"
  return button returned of response
end tell
APPLESCRIPT
)" || exit 0
install_args=()
[[ "$install_choice" == "Yes" ]] && install_args=(--install-codex-cli)

osascript -e 'display notification "Installation started" with title "Codex Inter-Agent Messaging"' || true
log_file="$(mktemp "${TMPDIR:-/tmp}/codex-inter-agent-installer.XXXXXX")"
set +e
/bin/bash "$backend" --repository-root "$repository_root" --codex-home "$codex_home" \
  "${codex_args[@]}" "${install_args[@]}" >"$log_file" 2>&1
exit_code=$?
set -e
details="$(tail -n 18 "$log_file")"
rm -f "$log_file"

if [[ "$exit_code" -eq 0 ]]; then
  osascript - "$details" <<'APPLESCRIPT'
on run argv
  tell application "System Events"
    activate
    display dialog "Installation completed. Open a new Codex task to discover the plugin.\n\n" & item 1 of argv buttons {"Done"} default button "Done" with title "Codex Inter-Agent Messaging Installer"
  end tell
end run
APPLESCRIPT
else
  osascript - "$details" <<'APPLESCRIPT'
on run argv
  tell application "System Events"
    activate
    display dialog "Installation failed.\n\n" & item 1 of argv buttons {"Close"} default button "Close" with title "Codex Inter-Agent Messaging Installer" with icon stop
  end tell
end run
APPLESCRIPT
fi

exit "$exit_code"
