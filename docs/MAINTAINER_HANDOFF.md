# Maintainer Handoff

Version 0.4.0 adds the installable Codex plugin, automatic singleton bootstrap, stock remote-CLI wrapper, and fail-closed per-generation owner binding to the existing synchronous, asynchronous, and group bridge. It remains an on-demand tool, not a coordinator.

## Code map

- `src/app_server/`: race-safe bootstrap/lock, signed descriptor, protected runtime identity, authenticated control plane, shared app-server owner, JSON-RPC client, event router, and turn collection.
- `src/messaging/`: MCP ingress, strict caller-bound tools, envelope framing, synchronous/asynchronous/group services, FIFO scheduler, retries, leases, and recovery.
- `src/store/`: schema-6 identities and per-generation owner bindings plus messages, attempts, ACLs, audit, inbox, groups, and snapshots.
- `src/cli/`: host lifecycle, remote Codex connection, registration/adoption/replacement, ACL/group, health, and backup commands.
- `plugins/` and `.agents/plugins/`: production plugin and repository marketplace; `scripts/build-plugin.mjs` assembles its runtime.
- `tests/unit/` and `tests/integration/`: deterministic protocol, security, scheduling, recovery, store, service, CLI, MCP, and real-host coverage.
- `tests/runtime/`: bounded real participating-thread smoke tests; the async smoke also exercises group fan-out.
- `generated/codex/`: exact installed-version protocol artifacts and drift manifest.

## Invariants to preserve

- Never accept sender identity or raw recipient thread IDs from model tool arguments.
- Never run a second app-server owner for a participating live thread.
- Reject unbound/foreign recipient ownership before leases or app-server thread calls; exact resumed/read thread IDs must match.
- Normal delivery uses `turn/start`, waits for an idle recipient, and never silently steers.
- Persist before dispatch; use message IDs, generations, idempotency, FIFO queues, and cross-process leases to prevent duplicate or stale delivery.
- Extract only authoritative final agent messages for synchronous replies; never expose reasoning or tool output.
- Asynchronous and group recipient output never creates a new edge automatically.
- Re-check ACLs and current identity readiness when creating or retrying an edge.
- Administrative registration, rebinding, ACL, and group membership operations stay outside MCP.
- Fail closed for unattended approvals and protocol drift; redact credentials, content, and sensitive paths from logs/errors.

## Verification and operations

The standard gate is `npm.cmd ci`, `verify:all`, coverage, plugin build/validate/smoke, and package smoke, followed by the bounded real bootstrap/ownership matrix when runtime behavior changes. `docs/evidence/authoritative-owner-integration.md` records v0.4 real owner and delivery IDs; final clean evidence is in `docs/evidence/final-verification.md`. Use `host status` plus `health` after startup/upgrades and back up before schema changes.

Compatibility limits, upgrade instructions, rollback, release checks, and current gaps are in `MAINTENANCE.md`. Installation, runtime operations, security assumptions, and feature semantics are in the sibling documentation files.
