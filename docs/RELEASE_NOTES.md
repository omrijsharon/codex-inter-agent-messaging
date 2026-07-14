# Release Notes

## v0.1.0 — MVP

Current status: v0.3.0 locally validated on Windows with Codex CLI `0.144.0-alpha.4`.

Highlights:

- On-demand `list_agents`, `ask_agent`, and `get_request_status` MCP tools with trusted caller binding.
- One bridge-managed authenticated shared app-server owner; no coordinator agent or autonomous orchestration.
- Existing-history registration, generations, explicit replacement, pairwise ACLs, and local operator CLI.
- Durable SQLite FIFO scheduling, cross-process leases, bounded retry, idempotency, crash reconciliation, cycle detection, and source-cancellation persistence.
- Authenticated, JSON-framed untrusted peer envelopes and authoritative final-reply extraction.
- Fail-closed unattended approvals, structured redacted logs, lifecycle audit events, diagnostics, and hot backup.

Known limitations:

- Participating clients must share the bridge-managed owner; independently owned desktop/app-server sessions cannot participate concurrently.
- Caller identity requires a distinct trusted MCP process configuration per agent.
- The normal deployment is single-user local Windows. Remote `wss:` is expert-only and not part of MVP acceptance.
- No at-rest encryption, external tamper-evident audit store, human approval UI, or multi-user admin roles.
- v0.1 provides synchronous request/reply only; upgrade to v0.3 for asynchronous inbox/reply and groups.
- Context compaction is exposed through the app-server adapter but is not performed automatically; unrecoverable saturation fails without rebinding.

Security assumptions and residual risks are documented in [`THREAT_MODEL.md`](THREAT_MODEL.md).

## v0.2.0 — Asynchronous messaging

- Adds `send_message`, `read_inbox`, `acknowledge_message`, `reply_to_message`, and `get_message_status`.
- Reuses the durable idle-only FIFO scheduler and adds inbox read/acknowledgement state.
- Adds expiry and dead-letter status with operator diagnostics.
- Enforces an explicit anti-loop invariant: recipient assistant output never creates another edge.

## v0.3.0 — Groups and channels

- Adds durable stable groups, owner/member roles, membership snapshots, and local operator administration.
- Adds `list_groups`, `send_group_message`, `get_group_message_status`, `retry_group_message`, and `gather_group_replies`.
- Fans out to independent per-recipient queues and preserves shared conversation IDs with distinct message/turn outcomes.
- Supports partial success and retry of failed recipients without redelivering successful recipients.
- Gathers only explicit replies and identifies the synthesizing agent.
- Re-checks active identities, ACLs, queue limits, and recipient readiness for selective retries.
- Adds clean-install package smoke coverage for all three installed entrypoints and in-place migration coverage from the v0.1 schema.

Maintenance constraints and the supported environment are recorded in [`MAINTENANCE.md`](MAINTENANCE.md); the final implementation map is in [`MAINTAINER_HANDOFF.md`](MAINTAINER_HANDOFF.md).

Final verification evidence, coverage, package installation, and real asynchronous/group runtime IDs are recorded in [`evidence/final-verification.md`](evidence/final-verification.md).
