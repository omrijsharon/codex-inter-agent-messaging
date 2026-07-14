# Phase 0 Decision — Prepare inter-agent thread

> Historical decision: superseded on 2026-07-14 by the user-selected bridge-managed shared-host boundary. See `DECISION_SHARED_HOST.md`. The unsafe independent-owner evidence remains authoritative.

## Decision

**Status: NO-GO for production implementation**  
**Recorded: 2026-07-14 15:26:38 +03:00 (Asia/Jerusalem)**  
**Codex build tested: `codex-cli 0.144.0-alpha.4`**

The user-authorized replacement target resolved the former context-exhaustion blocker and proved the core A-to-B-to-A mechanism. The gate still fails because safe delivery to a desktop-owned thread while it is active cannot be implemented with independent app-server ownership, and this Windows environment exposes no supported way for the MCP process to join the desktop's live owner.

## Proven with the dedicated existing target

- `Prepare inter-agent thread` was discovered and verified as existing thread `019f6082-fd66-7da2-aa9f-b6461c2c486d` without recreation.
- Trusted project configuration binds stable caller identity `prepare-inter-agent-thread` without a model-supplied sender argument.
- A real resumed target turn invoked all three MCP tools successfully.
- `inter-agent` sent an authenticated `INTER_AGENT_MESSAGE_V1` request and received `PHASE0_REPLY_OK` while its tool call remained unresolved.
- A real sender model turn persisted the MCP call/result and `PHASE0_PERSISTED_OK`; the matching recipient transcript persisted the authenticated envelope and identical final answer.
- A 1 ms bounded wait returned `pending`; status polling retrieved `PHASE0_PENDING_OK`; exactly one recipient turn existed for the message ID.

## Independent ownership is unsafe

One stdio app-server started a target turn that ran `Start-Sleep -Seconds 20`. While that turn was active, a second independently owned app-server resumed the same target and reported `idle`. The second delivery began before the first completed. Supported `thread/read` showed the first turn's `OWNER_A_DONE` final message persisted as the first item of Owner B's turn. This is observable transcript corruption/misattribution, not merely stale status.

Independent app-server processes must never deliver to a thread that may be owned by another Codex client.

## Shared MCP ownership is safe

`shared-ownership-probe.mjs` starts one capability-token-authenticated loopback WebSocket app-server and two separate MCP stdio processes. On the clean run:

- the shared owner reported the target `active`;
- the second MCP process received `RECIPIENT_BUSY` and created zero turns;
- Owner A completed with `SHARED_A_DONE`;
- Owner B retried after idle and completed with `SHARED_B_DONE` in one distinct turn;
- all child processes, clients, token material, and temporary state shut down cleanly.

Selected messaging-process topology: one authenticated local app-server owner plus a durable cross-process FIFO scheduler/lease.

## Desktop-owner blocker

Task 1.12 specifically requires a real desktop-started active turn to queue and run later without steering or corruption. The installed Windows Computer Use runtime cannot initialize, but UI automation is not the central blocker: even a manually started desktop turn would be invisible to an independently launched messaging app-server.

The CLI's supported daemon check returned: `codex app-server daemon lifecycle is only supported on Unix platforms`. The generated/current public app-server surface available here provides no trusted endpoint from the existing Windows desktop owner to the MCP child process. Therefore the bridge cannot safely observe, queue behind, or deliver into a desktop-owned active thread.

## Required architecture choice

Production may proceed only after one of these becomes explicit:

1. Codex desktop supplies the MCP process with a trusted authenticated binding to its live app-server owner, or an equivalent in-host adapter; or
2. The product scope changes so participating threads are deliberately hosted by the bridge-managed shared authenticated app-server (for example, compatible remote CLI clients), rather than arbitrary existing Windows desktop-owned sessions.

Accepting independent ownership, assuming desktop threads are idle, scraping rollout state, or silently steering are rejected as unsafe alternatives.

Milestone 1 remains unchecked and Milestone 2 must not begin.
