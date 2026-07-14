# Phase 0 Decision — Bridge-managed shared app-server

## Decision

**Status: GO for production implementation within the shared-host scope**  
**Recorded: 2026-07-14 16:36:40 +03:00 (Asia/Jerusalem)**  
**Codex build tested: `codex-cli 0.144.0-alpha.4`**

The user selected the supported product boundary: every participating thread runs through one bridge-managed, capability-token-authenticated shared app-server. This supersedes the desktop-owner requirement and the earlier scoped NO-GO in `DECISION_PREPARE.md`; it does not invalidate or remove that historical safety evidence.

## Feasibility evidence

- Existing histories for `inter-agent` and `Prepare inter-agent thread` were resumed by exact thread ID without recreation.
- Operator-controlled MCP configuration supplied trusted caller identities; the model cannot provide a sender argument.
- A real sender model turn persisted the MCP tool call and result, while the recipient persisted the authenticated envelope and matching final answer.
- Bounded waiting returned `pending`; later status recovery returned the same authoritative result and exactly one recipient turn.
- Independent app-server owners were proven unsafe and are forbidden.
- Two MCP processes connected to one authenticated shared owner saw authoritative active/idle state.
- Automatic queueing was exercised three times. In every run the second process stayed unresolved while the first recipient turn was active, then completed automatically with `SHARED_B_DONE` in exactly one later persisted turn. Observed waits were 41,550 ms, 27,184 ms, and 28,096 ms.
- Six deterministic tests passed, including active-to-idle waiting, a turn-start busy race, and bounded busy timeout. Schema verification passed 25 assertions, live registry verification passed, pending recovery passed, and `npm audit` found zero vulnerabilities.

## Supported ownership boundary

- The bridge starts and owns one local shared app-server endpoint.
- The endpoint requires a capability token supplied only through trusted local configuration.
- Participating Codex clients and MCP processes connect to that owner.
- An existing thread may retain its history, but any independent desktop/app-server owner must release it before registration or activation.
- The shared transport performs no autonomous coordination: every message still begins with an explicit agent tool call.

Arbitrary independently owned desktop sessions remain unsupported. A future host adapter may expand this boundary only if it provides a supported authenticated connection to the same live owner.

## Production requirements carried forward

The Phase 0 polling queue proves feasibility but is not the production scheduler. Production must add the planned durable FIFO queue, cross-process lease, idempotency record, crash reconciliation, bounded retry policy, and secure app-server lifecycle management before claiming MVP reliability.

Milestone 1 passes for the selected scope. Production implementation may proceed to Milestone 2.
