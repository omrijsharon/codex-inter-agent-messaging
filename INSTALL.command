#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
BACKEND="$ROOT/scripts/install-plugin-macos.sh"
WIZARD="$ROOT/scripts/install-wizard-macos.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'This installer requires macOS. Use INSTALL.cmd on Windows.\n' >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  exec /bin/bash "$WIZARD" --repository-root "$ROOT"
fi

exec /bin/bash "$BACKEND" --repository-root "$ROOT" "$@"
