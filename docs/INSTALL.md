# Installation and existing-thread setup

## Supported baseline

- Windows, Node.js 22.11+, npm 10.9+, and Codex CLI/app-server `0.144.0-alpha.4`
- A source checkout or reviewed release directory containing the repository marketplace
- Participating recipient histories that are closed in independently owned Codex desktop/IDE processes

The plugin is transport tooling, not a coordinator. Messages are sent only when an agent explicitly calls a messaging tool.

## Build and install the plugin

From the repository root:

```powershell
npm.cmd ci
npm.cmd run plugin:build
npm.cmd run plugin:validate
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

```powershell
codex-inter-agent host status
codex-inter-agent host stop
codex plugin marketplace upgrade codex-inter-agent-local
codex plugin remove codex-inter-agent-messaging
codex plugin add codex-inter-agent-messaging@codex-inter-agent-local
```

The desktop plugin settings toggle can disable/re-enable the plugin; CLI removal/addition is the equivalent. For a complete uninstall, stop the host, remove the plugin, then remove the marketplace. Plugin removal does not delete the database, logs, installation identity, or capability token. Delete retained state only as a separate explicit operator decision after backup.
