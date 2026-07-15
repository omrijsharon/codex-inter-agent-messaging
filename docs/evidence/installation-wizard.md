# Milestones 18-19 installation wizard verification

Verification completed on 2026-07-15 (Asia/Jerusalem) on Windows with Node.js 22.11.0, npm 10.9.0, Codex CLI/app-server 0.144.2, and package/plugin 0.4.0.

## Native GUI and desktop-only correction

- An Explorer-equivalent PATH reproduced the reported console failure: the Codex desktop Appx package was installed, but no public `codex` command was visible.
- The packaged `app\resources\codex.exe` returned access denied outside Appx context. A copied probe ran, confirming that copying it would be technically possible but unsupported and update-fragile; the installer explicitly rejects that path and editor-extension-private binaries.
- The native 780x600 WPF setup window detected the desktop app, displayed the compatible public CLI destination and `%USERPROFILE%\.codex`, exposed both Browse controls, defaulted official CLI recovery on, and rendered cleanly after a Windows PowerShell 5.1 Unicode-source regression was found and fixed by visual capture.
- The final exact `cmd.exe /d /c INSTALL.cmd` probe found and corrected two launcher-only defects: process-wide hidden-window state suppressed WPF visibility, and `%~dp0` ended in a separator before a native closing quote. Console-only hiding plus `%~dp0.` produced a visible titled window that closed normally without starting installation.
- `test:installer` passes eight backend/launcher scenarios, including Explorer PATH and desktop-only recovery planning. `test:installer:gui` launches actual STA windows and passes cancel, success, failure, and custom Unicode/spaced Codex-home states.
- The official OpenAI standalone installer was exercised in isolation. Recovery is pinned to Codex `0.144.2` from the generated protocol manifest rather than silently installing the current unreviewed latest version. Its package cache uses the selected Codex home through a Windows-compatible short alias to tolerate the upstream tar Unicode-path limitation.
- `smoke:installer` completed official CLI recovery with no Codex command on PATH, first plugin install, same-path refresh, plugin/CLI verification, user-PATH test-entry removal, temporary-tree removal, and `cleanup: clean`.
- Windows Computer Use was requested for the visible check, but its native control pipe was unavailable. The real window was therefore launched, captured after render, and visually inspected using the documented fallback; no browser-visible workflow was in scope.

## Installation contract and deterministic checks

- `INSTALL.cmd` invoked the repository-relative PowerShell wizard, preserved its exit code, and skipped its interactive pause only under the explicit test environment flag.
- `npm.cmd run test:installer` passed dry-run command planning, a downloaded-style path with spaces and Unicode, a same-name/different-root marketplace conflict, missing prerequisite failure, external exit-code propagation, and the root batch entrypoint.
- The wizard verified Node.js/npm minimums and the Codex plugin surface, then planned or executed six steps: locked dependency install, relocatable runtime build, plugin validation, current-user global CLI install, repository marketplace registration, and plugin install/refresh.
- A same-path Codex marketplace add returned `alreadyAdded: true` on the second pass. A different root with the same marketplace name was rejected without configuration mutation.
- Harmless native stderr warnings remain diagnostic output; only the native process exit code determines command failure.

## Installed-path and repeated-build regressions

- Two consecutive `plugin:build` runs passed after runtime replacement gained five bounded 100 ms Windows retries for transient recursive-remove locks.
- CLI, host, and MCP executable guards now compare filesystem identity instead of raw file-URL spelling. A hard-link regression test passed, and a real npm-global CLI installation under an 8.3 short root with spaces and Unicode returned version 0.4.0 and complete help.
- The installer rejects an empty or mismatched installed CLI version rather than reporting a false success.
- First-run installation identity creation writes and syncs a private candidate, atomically links the complete UUID into place, accepts a concurrent winner, and removes its candidate. A 20-caller unit race and three consecutive three-process bootstrap integration runs converged without a partial identity or temporary file.

## Clean full gate

After `npm.cmd ci --no-audit --no-fund` installed 299 locked packages:

- `npm.cmd run verify:all` passed formatting, ESLint, strict TypeScript, 93 unit tests in 17 files, the six installer scenarios, 12 integration tests in 6 files, installed-schema drift, and production build.
- `npm.cmd run test:coverage` passed all 105 tests in 23 files with 72.81% statements, 68.45% branches, 80.39% functions, and 76.19% lines.
- Generated protocol validation passed for Codex CLI 0.144.2: 1,008 files and digest `00d059e58c3fe4320c38af5bca1070f7a72d06c1598937991b035845e5f57627`.
- Parsed aggregate-schema comparison against 0.144.0-alpha.4 found zero structural changes; only aggregate-definition ordering changed. Required thread, turn, completion, approval, client-message-ID, and remote connection surfaces remain present.
- Repository validation and the official plugin-creator validator passed.
- `smoke:plugin` discovered all 13 tools from a copied Unicode/spaced path and rejected an unknown trusted caller before host startup.
- `smoke:package` clean-installed `codex-inter-agent-messaging-0.4.0.tgz` and verified all three commands.
- `smoke:installer` performed a first install and idempotent refresh in isolated Codex/npm homes, found the plugin installed/enabled, ran CLI version/help, and returned `cleanup: clean`.
- `smoke:stability` completed three clean ownership generations, converged three MCP clients on one owner, recovered a crashed supervisor, returned `UNSUPPORTED_THREAD_OWNER` before delivery, and returned `cleanup: clean`.

## Cleanup and scope

The final audit found no installer/stability process, temporary test directory, descriptor, lock, SQLite database, log, or package archive. The isolated tests left no `codex-inter-agent-local` marketplace or `codex-inter-agent-messaging` plugin in the operator's real Codex home. The installer did not select `BRIDGE_AGENT_ID`, register/adopt/replace a history, stop a host, start a delivery, or modify Codex internal state.
