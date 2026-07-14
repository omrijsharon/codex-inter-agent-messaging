# Codex plugin integration evidence

Evidence date: 2026-07-14 (Asia/Jerusalem)

## Package and marketplace

The production plugin is `codex-inter-agent-messaging` `0.4.0` in the repository marketplace `codex-inter-agent-local`. Its manifest declares the root `.mcp.json`; only `plugin.json` lives under `.codex-plugin/`. The MCP definition uses `node`, a plugin-relative runtime entrypoint, `cwd: "."`, forwarded trusted configuration names, bounded 45-second startup/300-second tool timeouts, optional server startup, and `writes` approval mode. It contains no token, database, live thread ID, or workstation path.

Codex's plugin-creator validator and the repository validator both passed. The source build assembled an exact production runtime with the native SQLite dependency. The installed-copy smoke ran from a temporary path containing spaces and Unicode, initialized MCP, found all 13 tools, called `list_agents`, stopped the host, and removed the temporary copy. An initial Windows `spawnSync npm.cmd EINVAL` was fixed by invoking npm's JavaScript entrypoint without a shell.

## Real Codex CLI installation and tool call

Commands used the supported plugin CLI:

```text
codex plugin marketplace add <repository-root> --json
codex plugin add codex-inter-agent-messaging@codex-inter-agent-local --json
```

Codex reported the plugin `installed, enabled` in its cache. The development reinstall used Codex's required cachebuster workflow after a tool-annotation change.

A dedicated temporary bridge registered `plugin-test` against the existing `Prepare inter-agent thread` test history. Fresh ephemeral Codex CLI session `019f6204-966c-7600-91a1-6b7021187259` loaded the installed cached plugin, completed `codex-inter-agent-messaging/list_agents`, and returned:

```text
PLUGIN_CLI_OK plugin-test
```

The first attempt had been safely cancelled because `list_agents` lacked an MCP read-only annotation under the plugin's `writes` approval mode. The annotation was corrected, the plugin was rebuilt/reinstalled, and the successful rerun proves the tool was callable rather than merely listed. The host nonce was `ef25339e-c34d-40f4-8ae7-18a3ae881a85`; final authenticated stop removed its descriptor and process pair.

## Multiple tasks and subagent

Two simultaneous ephemeral Codex tasks plus one bounded subagent run used one supervisor (`30016`), one Codex app-server child (`29568`), and nonce `3780a7fa-2f78-4bf5-9e17-c18e27381fe4`. Five MCP client registration events were observed across runtime boundaries, with three leases still live at the status snapshot. No second host existed. The subagent completed with `SUBAGENT_OK`, inherited the explicitly supported parent task-tree principal, and had no model argument capable of choosing another identity. Final stop removed the descriptor and both host processes.

## Desktop boundary

The plugin was installed while official desktop `26.707.3748.0` was running, but this active implementation thread was not restarted and no UI automation was used to manufacture a replacement task. Current official documentation states desktop MCP support, but the pinned desktop still owns its task histories through a private stdio app-server and exposes no supported authenticated owner adapter. Consequently the release claims real CLI/custom-client plugin integration, not direct delivery to desktop-owned histories. Desktop tool discovery may be rechecked manually after a safe app restart, but it cannot relax `UNSUPPORTED_THREAD_OWNER` behavior.

## Cleanup

Each dedicated runtime used a temporary data directory and authenticated host stop. Descriptors and host processes were absent afterward. Temporary plugin test data and the development marketplace installation are removed during the final release cleanup; protected capability/database state is never included in release artifacts.
