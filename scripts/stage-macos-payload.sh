#!/bin/bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: stage-macos-payload.sh SOURCE_ROOT DESTINATION_ROOT\n' >&2
  exit 2
fi

source_root="$(cd "$1" && pwd -P)"
destination_root="$2"

rm -rf "$destination_root"
mkdir -p "$destination_root/scripts" "$destination_root/generated/codex" \
  "$destination_root/.agents/plugins" "$destination_root/plugins/codex-inter-agent-messaging"

cp "$source_root/package.json" "$source_root/package-lock.json" \
  "$source_root/tsconfig.json" "$source_root/tsconfig.build.json" "$destination_root/"

for optional_file in README.md RELEASES.md CODEX_INTER_AGENT_MESSAGING_BRIDGE.md; do
  [[ -f "$source_root/$optional_file" ]] && cp "$source_root/$optional_file" "$destination_root/"
done
[[ -d "$source_root/docs" ]] && cp -R "$source_root/docs" "$destination_root/docs"
cp -R "$source_root/src" "$destination_root/src"
cp "$source_root/scripts/build-plugin.mjs" \
  "$source_root/scripts/validate-plugin.mjs" \
  "$source_root/scripts/install-plugin-macos.sh" \
  "$source_root/scripts/stage-macos-payload.sh" \
  "$destination_root/scripts/"
cp "$source_root/generated/codex/manifest.json" "$destination_root/generated/codex/"
cp "$source_root/.agents/plugins/marketplace.json" "$destination_root/.agents/plugins/"
cp -R "$source_root/plugins/codex-inter-agent-messaging/.codex-plugin" \
  "$destination_root/plugins/codex-inter-agent-messaging/"
cp "$source_root/plugins/codex-inter-agent-messaging/.mcp.json" \
  "$source_root/plugins/codex-inter-agent-messaging/README.md" \
  "$destination_root/plugins/codex-inter-agent-messaging/"

chmod 0755 "$destination_root/scripts/install-plugin-macos.sh" \
  "$destination_root/scripts/stage-macos-payload.sh"
