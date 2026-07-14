# Installation and Existing-Thread Setup

## Prerequisites

- Windows with Node.js 22.11+ and npm 10.9+
- Codex CLI `0.144.0-alpha.4` for the pinned v0.3 build
- Participating thread histories that can be resumed by the bridge-managed app-server

The MVP does not attach to an independently owned desktop/app-server session. Stop the independent owner before making that history participate. Every participating client and caller-bound MCP process must use the one shared owner while messaging is enabled.

## Install

From a source checkout:

```powershell
npm.cmd ci
npm.cmd run verify:all
npm.cmd pack
npm.cmd install --global .\codex-inter-agent-messaging-0.3.0.tgz
```

Start the transport owner in a dedicated terminal. It does not coordinate or initiate work.

```powershell
codex-inter-agent-host
```

The default dynamic loopback endpoint is written to `%USERPROFILE%\.codex-inter-agent\connection.json`; the capability token is stored separately in `app-server.token`. Keep both under the owning OS account. A fixed endpoint may instead be configured with `BRIDGE_APP_SERVER_LISTEN_URL=ws://127.0.0.1:45123`.

## Register existing histories

Use exact thread IDs. Titles are only a discovery aid.

```powershell
codex-inter-agent discover "Prepare inter-agent thread"
codex-inter-agent register --agent-id prepare-inter-agent-thread --display-name "Prepare inter-agent thread" --thread-id <exact-thread-id> --workspace <workspace>
codex-inter-agent register --agent-id inter-agent --display-name "inter-agent" --thread-id <exact-thread-id> --workspace <workspace>
codex-inter-agent list
codex-inter-agent health
```

Registration verifies the exact history through app-server. It does not recreate, fork, inject into, or edit the history.

## Enable the MCP tool per participating caller

Each participating caller needs a trusted, distinct process configuration. Do not expose `BRIDGE_AGENT_ID` as a model argument. Configure the MCP server in the caller's trusted Codex project/profile configuration, using the stable ID registered above:

```toml
[mcp_servers.codex_inter_agent]
command = "codex-inter-agent-mcp"

[mcp_servers.codex_inter_agent.env]
BRIDGE_AGENT_ID = "inter-agent"
BRIDGE_DATA_DIRECTORY = "C:\\Users\\you\\.codex-inter-agent"
```

Use a separate trusted project/profile entry with its own `BRIDGE_AGENT_ID` for every other caller. Refresh or restart that participating client after changing MCP configuration. A host surface that cannot bind a caller-specific MCP process or connect to the shared owner is unsupported by v0.3.

## ACL policy

The default missing-rule policy is `allow` for a simple trusted-local setup. For deny-by-default operation set `BRIDGE_ACL_DEFAULT_POLICY=deny` in every MCP process, then add explicit rules:

```powershell
codex-inter-agent acl allow inter-agent prepare-inter-agent-thread
codex-inter-agent acl list
```

## Verify

Call `list_agents`, then `ask_agent` with a stable recipient ID. A long request may return `pending`; use `get_request_status` with the returned message ID. Never create another request merely to poll the first one.
