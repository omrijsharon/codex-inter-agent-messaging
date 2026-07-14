# Phase 0 Decision Record

> Supersession note — 2026-07-14 15:08:31 +03:00: the user explicitly replaced the saturated ESP32 recipient with the dedicated existing `Prepare inter-agent thread` (`019f6082-fd66-7da2-aa9f-b6461c2c486d`, stable ID `prepare-inter-agent-thread`). The NO-GO below remains the historical decision for the former target. The hard gate is being rerun against the authorized replacement and must receive a new final decision.

## Decision

**Status: NO-GO for production implementation**  
**Recorded: 2026-07-14 13:05:26 +03:00 (Asia/Jerusalem)**  
**Codex build tested: `codex-cli 0.144.0-alpha.4`**

Milestone 1 remains open. Tasks 1.1–1.7 passed, but the mandatory successful exchange between the existing `inter-agent` and `Update ESP32S3-CAM webapp` threads did not complete. Milestone 2 must not begin until an operator makes the named recipient viable without violating the history-preservation requirement.

## Proven

- Generated schemas match the installed app-server build and contain the required thread, turn, event, MCP, and dynamic-tool fields used by the spike.
- Both existing threads were discovered and read through supported app-server APIs.
- Stable agent IDs are administratively mapped separately from display titles and exact thread IDs.
- Per-project MCP process configuration supplies a trusted, non-model-controlled sender identity.
- The same MCP server exposes `list_agents`, `ask_agent`, and `get_request_status` to both original thread runtimes.
- A real `ask_agent` invocation from the `inter-agent` runtime resolved the target mapping, built the peer envelope, kept the sender request open, started a recipient turn, correlated its terminal event, and returned its structured failure.
- Independent app-server processes can resume the named threads and make direct MCP inventory/tool calls. This proves basic concurrent read/tool access, but does not yet prove safe simultaneous turn ownership.

## Not proven

- A successful recipient model turn and final `agentMessage`.
- Persistence of a successful authenticated inbound envelope in the recipient transcript.
- Return of the recipient answer as the original sender tool result.
- Pending-to-completed recovery for a successful delivery.
- Busy desktop-turn queueing.
- Safe simultaneous turn ownership and the final app-server ownership topology.

## Blocking result

The existing recipient thread `019f0270-a4c3-7c71-aaa4-6cc80b5baa06` is saturated. The real bridge attempt created correlated turn `019f6003-934a-72c2-af8c-675ef873ee93`, which failed before model sampling with `contextWindowExceeded`. It produced no final agent message. A later `thread/read` represented the failed pre-sampling attempt as an empty completed turn, so assigned turn IDs and read-back status alone cannot be treated as delivery success.

## History-preserving recovery attempts

All of the following failed:

1. Resume with the thread's recorded `gpt-5.3-codex-spark` model.
2. Resume with `gpt-5.6-terra` at medium reasoning.
3. Supported `thread/compact/start` on the original thread.
4. A larger configured context/auto-compaction threshold with `gpt-5.6-terra`.
5. An ephemeral fork with an injected `context_compaction` item; app-server accepted the generated schema shape, but the upstream endpoint rejected that item type.
6. An ephemeral fork with `compaction_trigger`; the remote compact task still exceeded context.
7. A fresh ephemeral helper with `experimentalRawEvents=true`; manual compaction emitted no reusable raw compaction event before the bounded timeout.

No rollout file or Codex database was edited or scraped as a messaging mechanism. No original target history was cleared, rolled back, fork-rebound, or deleted.

## Caller identity binding

Selected Phase 0 binding: operator-controlled project MCP configuration launches the server with `PHASE0_AGENT_ID`. The model cannot supply or override the sender. The production design must replace the Phase 0 environment variable convention with a hardened local credential/config binding and retain the same no-sender-argument property.

## Refresh behavior

Project `.codex/config.toml` is visible to fresh Codex/app-server processes. Existing desktop sessions may require a new turn, MCP reload, or client restart before model tool selection changes. App-server `mcpServerStatus/list` and `mcpServer/tool/call` provide authoritative runtime visibility without relying on model selection.

## App-server ownership

No final topology is selected. Independent stdio app-server processes successfully performed thread resume, read, MCP inventory, and direct MCP calls against the same persisted threads. Safe simultaneous `turn/start` ownership with a desktop-active recipient remains unproven. Production must not infer safety from read-only/direct-tool coexistence.

## Re-entrancy

The sender-side MCP request remained unresolved while its tool runtime started and observed the recipient turn, so the basic nested JSON-RPC/app-server event loop is re-entrant. End-to-end successful re-entrancy remains unproven because the recipient failed before sampling.

## Architecture revision

The architecture now defines `RECIPIENT_CONTEXT_EXHAUSTED` as a terminal address-readiness failure. Ordinary delivery must never silently compact, fork, clear, roll back, recreate, or rebind a recipient. Manual supported compaction is operator-visible. If compaction cannot recover the thread, the stable agent ID remains unavailable until an operator explicitly maps a viable thread generation.

## Required operator decision

Choose one before repeating tasks 1.8–1.13:

1. Successfully compact the existing target through a supported Codex client and keep its thread ID; or
2. Explicitly rebind `update-esp32s3-cam-webapp` to another viable existing/forked thread generation while preserving the saturated thread as an immutable failure fixture.

Until then, the hard gate is enforced and production work is prohibited.
