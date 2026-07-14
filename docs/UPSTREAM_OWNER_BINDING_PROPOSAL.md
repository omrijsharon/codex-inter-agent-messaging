# Upstream proposal: authenticated per-thread owner binding

## Problem

Codex CLI `0.144.0-alpha.4` can attach its TUI to an external app-server with `--remote` and `--remote-auth-token-env`, so the bridge can safely give participating CLI tasks one app-server owner. The official Windows desktop build `26.707.3748.0` instead owns its histories through a private stdio app-server. The public protocol does not expose an authenticated mapping from that private owner to a plugin MCP caller or an exclusive live-owner claim for a thread.

Without that mapping, a second app-server can read persisted history but cannot prove that its status is authoritative. A bridge must not infer ownership from a title, rollout file, process list, or model-supplied thread ID.

## Minimum API

Add an authenticated, capability-negotiated owner API to app-server:

1. `owner/identity` returns an opaque owner ID, process generation, transport, app-server version, and supported ownership capabilities.
2. `thread/owner/claim` atomically claims one thread for an owner generation and returns an opaque claim token. It fails if another live owner holds the thread.
3. `thread/owner/status` returns the current owner generation and authoritative live thread status without revealing another owner's token.
4. `thread/owner/release` releases only a matching claim token and generation.
5. `turn/start` optionally requires the matching claim token; a stale, missing, or foreign claim returns a stable ownership error before creating a turn.
6. Plugin MCP startup receives authenticated current task/thread identity and owner identity as host metadata, never as model tool arguments.

Claims need bounded leases, crash recovery, compare-and-swap generation semantics, and audit events. Re-entrant delivery to the current active task must be rejected or explicitly queued; it must never steer an unrelated turn.

## Security and compatibility

- Keep local transport and OS-user authority as the default trust boundary.
- Never put bearer tokens in process arguments, prompts, logs, rollout files, or MCP schemas.
- Negotiate the feature so older clients return `UNSUPPORTED_THREAD_OWNER` rather than silently falling back.
- Preserve approval and sandbox policy on `turn/start`; an owner claim is routing authority, not side-effect approval.
- Desktop, CLI, IDE, and custom clients should use the same protocol contract.

Until such an API ships, this project supports CLI tasks launched through its authenticated remote wrapper and rejects unbound/foreign recipients. It does not patch binaries, automate the desktop UI, or edit Codex internal history state.
