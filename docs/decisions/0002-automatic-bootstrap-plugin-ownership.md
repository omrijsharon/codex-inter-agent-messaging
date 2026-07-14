# ADR 0002: Plugin bootstrap with one bridge-managed owner

- Status: accepted
- Date: 2026-07-14

## Context

Codex plugins can bundle local STDIO MCP servers, and Codex clients may create multiple MCP processes across tasks, resumes, subagents, and applications. The bridge therefore needs an idempotent process bootstrap rather than a manually maintained host terminal or a belief that MCP starts once. At the same time, previous real-runtime evidence showed that two independent app-server owners can overlap work and misattribute replies for one history.

The pinned environment is Codex CLI/app-server `0.144.0-alpha.4` and official Windows desktop app `26.707.3748.0`. The desktop launches its own `codex.exe app-server` child over private stdio. The installed Windows CLI reports that `codex app-server daemon` lifecycle management is Unix-only. Current official documentation describes plugin-bundled MCP, local STDIO MCP, hooks, open-source CLI/app-server integration, and experimental app-server WebSocket transport, but does not document an authenticated adapter to the desktop app's private live owner.

Official references:

- <https://learn.chatgpt.com/docs/build-plugins>
- <https://learn.chatgpt.com/docs/extend/mcp>
- <https://learn.chatgpt.com/docs/hooks>
- <https://learn.chatgpt.com/docs/app-server>
- <https://learn.chatgpt.com/docs/open-source>

## Decision

Proceed with automatic bootstrap for the supported open-source CLI/app-server and custom-client topology. A plugin-provided STDIO MCP process calls one race-safe `ensureHostRunning()` path. Concurrent callers use a protected atomic lock, double-check authenticated readiness after acquiring it, and converge on a detached per-user bridge host. The host publishes a non-secret descriptor, keeps its capability token separate, negotiates bridge/protocol/installation/database/owner identity, and outlives individual MCP clients. The initial policy has no idle shutdown; explicit authenticated operator commands own stop and restart.

Trusted caller identity remains operator-controlled `BRIDGE_AGENT_ID` configuration or a future verified host binding. It is never a model tool argument. A shared generic plugin installation without a trusted per-caller binding may list no messaging tools or fail initialization; it must not guess identity from a title.

Official desktop and IDE histories remain unsupported as delivery targets while privately owned. Seeing or invoking an MCP tool does not prove that the bridge controls that task's app-server. The bridge returns `UNSUPPORTED_THREAD_OWNER` rather than starting another owner. A future adapter requires a documented authenticated owner binding that provides current caller/thread identity, owner identity, status/read/resume/start operations, and re-entrant event routing.

No plugin `SessionStart` hook is required for correctness. MCP startup is the bootstrap trigger. A future hook may run only a bounded call to the same idempotent bootstrap function.

## Consequences

- Supported CLI/custom-client users no longer manually run `codex-inter-agent-host`.
- Multiple MCP processes are expected and safe; exactly one compatible host owns the shared app-server.
- Upgrade skew fails closed and requires an explicit host restart rather than creating a second owner.
- Desktop plugin discovery and desktop thread ownership are documented as different capabilities.
- The project will prepare an upstream desktop-host API proposal instead of patching the signed desktop binary or modifying internal history state.
