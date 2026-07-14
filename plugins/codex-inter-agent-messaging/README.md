# Codex Inter-Agent Messaging plugin

This plugin contributes the local `codex-inter-agent-messaging` STDIO MCP server. The installed server automatically starts or reuses one authenticated per-user bridge host; it does not coordinate agents or send work without an explicit tool call.

The release artifact contains a relocatable `runtime/` assembled by `npm run plugin:build`. A source checkout must run that command before installing this repository-local marketplace. Set trusted `BRIDGE_AGENT_ID` in the Codex process/profile environment before opening a participating task. The sender identity is never accepted as a tool argument.

Official desktop- and IDE-owned histories are not delivery targets on builds without a supported authenticated owner adapter. Tool discovery does not change that ownership boundary.

## Development installation lifecycle

From the repository root, build and validate the relocatable runtime before adding the repository marketplace:

```powershell
npm.cmd ci
npm.cmd run plugin:build
npm.cmd run plugin:validate
codex plugin marketplace add .
codex plugin add codex-inter-agent-messaging@codex-inter-agent-local
```

Open a new Codex task after installation. In the desktop app, use the plugin settings toggle to disable or re-enable the plugin. The CLI equivalent is removal followed by installation:

```powershell
codex plugin remove codex-inter-agent-messaging
codex plugin add codex-inter-agent-messaging@codex-inter-agent-local
```

After changing plugin contents, run `npm.cmd run plugin:build`, update the development cachebuster with the repository's plugin-creator workflow, and reinstall the plugin. To refresh all installed plugins from this marketplace, use:

```powershell
codex plugin marketplace upgrade codex-inter-agent-local
```

Before an upgrade or uninstall, stop the authenticated host after checking for active work:

```powershell
codex-inter-agent host status
codex-inter-agent host stop
codex plugin remove codex-inter-agent-messaging
codex plugin marketplace remove codex-inter-agent-local
```

Plugin removal does not delete the bridge database or protected per-user state. Do not use `host stop --force` unless intentionally interrupting active deliveries.
