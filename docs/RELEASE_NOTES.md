# Release Notes

## Installation wizard update (unreleased)

- Adds root `INSTALL.cmd` plus an idempotent PowerShell wizard for locked build/validation, current-user CLI installation, repository marketplace registration, plugin installation/refresh, and post-install verification.
- Adds dry-run/JSON diagnostics, fail-closed marketplace collision handling, deterministic installer tests, and an isolated first-install/reinstall/cleanup smoke test.
- Fixes CLI/host/MCP executable detection for equivalent Windows short, long, linked, spaced, and Unicode paths, and adds bounded recovery for transient Windows plugin-runtime replacement locks.
- Regenerates protocol artifacts for Codex CLI/app-server `0.144.2`: 1,008 files, digest `00d059e58c3fe4320c38af5bca1070f7a72d06c1598937991b035845e5f57627`. Structural comparison against `0.144.0-alpha.4` found no schema changes; only aggregate-definition order changed.

## v0.4.0 — Automatic-bootstrap Codex plugin

- Adds an installable repository-marketplace Codex plugin with a relocatable production MCP runtime and 13 strict caller-bound tools.
- Starts/reuses one detached authenticated per-user host from MCP/CLI, with atomic locking, signed schema-3 descriptors, separate capability tokens, authenticated health/control, client leases, safe stop/restart, and stale/crash recovery.
- Adds `codex-inter-agent connect`, using stock Codex remote TUI support while keeping bearer tokens out of process arguments and shell history.
- Adds bridge owner protocol 2, live capability negotiation, schema-6 per-generation ownership bindings, idle-only owner adoption, exact thread identity checks, and terminal `UNSUPPORTED_THREAD_OWNER` rejection before delivery.
- Adds read/write MCP annotations, plugin lifecycle/security documentation, clean-install Unicode-path smoke, release secret/state scanning, multi-task/subagent acceptance, and bounded real automatic-topology exchanges.

Compatibility and limitations:

- Validated on Windows with Codex CLI/app-server `0.144.0-alpha.4`, desktop `26.707.3748.0`, Node `22.11.0`, npm `10.9.0`, and MCP SDK `1.29.0`.
- v0.3/schema-5 data upgrades in place, but migrated registrations are unverified until confirmed adoption through the shared owner.
- Official desktop/IDE private histories remain unsupported delivery targets because the pinned public protocol has no authenticated exclusive owner claim. No binary patch or UI automation is included.
- Roll back only by stopping all bridge/plugin processes and restoring the complete pre-upgrade schema-5 backup with v0.3; there is no down-migration.

See [`evidence/authoritative-owner-integration.md`](evidence/authoritative-owner-integration.md), [`PLUGIN_SECURITY.md`](PLUGIN_SECURITY.md), and [`UPSTREAM_OWNER_BINDING_PROPOSAL.md`](UPSTREAM_OWNER_BINDING_PROPOSAL.md).

## v0.1.0 — MVP

Current status: v0.4.0 plus the unreleased installation-wizard update is locally validated on Windows with Codex CLI `0.144.2`.

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
