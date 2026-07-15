#!/bin/bash

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)"
output_root="${1:-$root/artifacts/macos}"
app_name="Codex Inter-Agent Messaging Installer.app"
app="$output_root/$app_name"
contents="$app/Contents"
macos="$contents/MacOS"
resources="$contents/Resources"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/codex-inter-agent-macos-build.XXXXXX")"
trap 'rm -rf "$build_root"' EXIT

rm -rf "$output_root"
mkdir -p "$macos" "$resources"
cp "$root/installer/macos/Info.plist" "$contents/Info.plist"

source_file="$root/installer/macos/InstallerApp.swift"
arm_binary="$build_root/installer-arm64"
intel_binary="$build_root/installer-x86_64"
xcrun swiftc -O -target arm64-apple-macos13.0 "$source_file" -o "$arm_binary" -framework AppKit
xcrun swiftc -O -target x86_64-apple-macos13.0 "$source_file" -o "$intel_binary" -framework AppKit
lipo -create "$arm_binary" "$intel_binary" -output "$macos/Codex Inter-Agent Messaging Installer"
chmod 0755 "$macos/Codex Inter-Agent Messaging Installer"

/bin/bash "$root/scripts/stage-macos-payload.sh" "$root" "$resources/payload"
plutil -lint "$contents/Info.plist"
architectures="$(lipo -archs "$macos/Codex Inter-Agent Messaging Installer")"
[[ "$architectures" == *"arm64"* && "$architectures" == *"x86_64"* ]] || {
  printf 'Universal build is missing an architecture: %s\n' "$architectures" >&2
  exit 1
}

codesign --force --deep --sign - "$app"
codesign --verify --deep --strict --verbose=2 "$app"
"$macos/Codex Inter-Agent Messaging Installer" --self-test

archive="$output_root/Codex-Inter-Agent-Messaging-Installer-macOS-universal.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
shasum -a 256 "$archive" >"$archive.sha256"
printf 'Built %s (%s)\n' "$archive" "$architectures"
