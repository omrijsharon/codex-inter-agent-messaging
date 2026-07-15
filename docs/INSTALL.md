# Installation and existing-thread setup

## Supported baseline

- Windows, Node.js 22.11+, npm 10.9+, and Codex CLI/app-server `0.144.2`
- A source checkout or reviewed release directory containing the repository marketplace
- Participating recipient histories that are closed in independently owned Codex desktop/IDE processes

The plugin is transport tooling, not a coordinator. Messages are sent only when an agent explicitly calls a messaging tool.

## One-click Windows installation

After downloading or cloning the repository, review the source and double-click `INSTALL.cmd` in the repository root. The console stays open and reports the failed step if installation cannot finish. Administrator privileges are not normally required; Node.js/npm must have a writable current-user global prefix.

The wizard performs these bounded actions:

1. Checks Node.js 22.11+, npm 10.9+, and the Codex plugin command surface.
2. Runs the locked dependency install, production/plugin build, and plugin validation.
3. Installs the companion `codex-inter-agent` CLI into npm's current-user global prefix.
4. Registers this repository as marketplace `codex-inter-agent-local`.
5. Installs or refreshes `codex-inter-agent-messaging@codex-inter-agent-local` and verifies that it is enabled.

It does not set `BRIDGE_AGENT_ID`, register or replace agents, stop a running host, start a delivery, or modify Codex histories. Rerunning it from the same repository is safe. Keep the downloaded repository at the same location for future refreshes; the installed plugin is cached, but its local marketplace remains associated with this repository path.

To check prerequisites and view the exact command plan without changing anything:

```powershell
.\INSTALL.cmd -DryRun
```

For machine-readable diagnostics without writes:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1 -DryRun -Json
```

After a successful install, completely restart Codex or open a new task. Existing active tasks do not gain newly installed MCP tools mid-session.

## Manual installation

From the repository root:

```powershell
npm.cmd ci
npm.cmd run plugin:build
npm.cmd run plugin:validate
npm.cmd install --global . --no-audit --no-fund
codex plugin marketplace add .
codex plugin add codex-inter-agent-messaging@codex-inter-agent-local
```

The build creates a relocatable production runtime under the plugin. Open a new Codex task after installation. The first plugin MCP process starts one hidden, detached, authenticated bridge host; later tasks reuse it. Do not run `codex-inter-agent-host` manually during normal operation.

## Bind a trusted caller identity

Set `BRIDGE_AGENT_ID` in the trusted Codex project/profile environment before opening each participating task. It must be one stable registered agent ID. Never put sender identity in a prompt or tool argument. All processes that should share the bridge must use the same `BRIDGE_DATA_DIRECTORY`; omit it to use the protected per-user default.

For example, in a trusted launch profile/environment:

```powershell
$env:BRIDGE_AGENT_ID = "inter-agent"
$env:BRIDGE_DATA_DIRECTORY = "$HOME\.codex-inter-agent"
codex-inter-agent connect
```

`connect` starts/reuses the owner and launches the stock Codex TUI with `--remote` while passing the bearer token through a child-only environment variable. Arguments can follow `--`, for example `codex-inter-agent connect -- resume <thread-id>`.

## Register histories

Use exact thread IDs; titles are discovery aids only:

```powershell
codex-inter-agent discover "Prepare inter-agent thread"
codex-inter-agent register --agent-id prepare-inter-agent-thread --display-name "Prepare inter-agent thread" --thread-id <exact-thread-id> --workspace <workspace>
codex-inter-agent register --agent-id inter-agent --display-name "inter-agent" --thread-id <exact-thread-id> --workspace <workspace>
codex-inter-agent list
codex-inter-agent health
```

Registration verifies and resumes the exact history through the shared owner. It does not fork, inject into, or edit history files.

Schema-5 and older registrations migrate as unverified. After closing that thread in every independently owned Codex app, adopt the unchanged generation through the shared owner:

```powershell
codex-inter-agent adopt-owner <agent-id> --generation <n> --confirm-agent-id <agent-id>
```

Adoption is idle-only and preserves the stable ID, thread ID, generation, workspace, and transcript. The current protocol cannot detect a private desktop owner opened later, so participating target histories must continue to run through `connect`.

## Verify first use

Open a new caller task with its trusted `BRIDGE_AGENT_ID`, call `list_agents`, then call `ask_agent` using a stable recipient ID. If the call returns `pending`, poll the same message with `get_request_status`; do not create a second request merely to poll.

For deny-by-default routing, configure `BRIDGE_ACL_DEFAULT_POLICY=deny`, then add explicit rules:

```powershell
codex-inter-agent acl allow inter-agent prepare-inter-agent-thread
codex-inter-agent acl list
```

## Upgrade, disable, and uninstall

To refresh from an updated checkout at the same path, double-click `INSTALL.cmd` again. The wizard rebuilds from the lockfile and uses Codex's idempotent marketplace/plugin installation. It never stops a running host; if the new plugin reports `HOST_INCOMPATIBLE`, finish active deliveries and perform an explicit host restart.

If the repository moved, the wizard fails closed when `codex-inter-agent-local` still points at the old location. Remove only that known marketplace after verifying its path, then rerun the installer from the new location:

```powershell
codex plugin marketplace list
codex plugin marketplace remove codex-inter-agent-local
.\INSTALL.cmd
```

Manual refresh or disable/re-enable:

```powershell
codex-inter-agent host status
codex-inter-agent host stop
codex plugin remove codex-inter-agent-messaging@codex-inter-agent-local
codex plugin add codex-inter-agent-messaging@codex-inter-agent-local
```

Local marketplaces are read directly; `marketplace upgrade` refreshes Git-backed marketplace snapshots and is not required for this repository path.

For a complete program uninstall:

```powershell
codex-inter-agent host status
codex-inter-agent host stop
codex plugin remove codex-inter-agent-messaging@codex-inter-agent-local
codex plugin marketplace remove codex-inter-agent-local
npm.cmd uninstall --global codex-inter-agent-messaging
```

The desktop plugin settings toggle can disable/re-enable the plugin; CLI removal/addition is the equivalent. Plugin removal does not delete the database, logs, installation identity, or capability token. Delete retained state only as a separate explicit operator decision after a backup; do not delete it while a host or delivery is active.
