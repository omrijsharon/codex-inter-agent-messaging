# Maintainer Handoff

Version 0.3.0 implements the full planned bridge: synchronous request/reply, explicit asynchronous messaging, authorized group fan-out, durable recovery, local administration, diagnostics, and clean-install packaging. It remains an on-demand tool, not a coordinator; participating clients share the bridge-owned app-server only so thread state and delivery ownership are authoritative.

## Code map

- `src/app_server/`: authenticated shared owner, JSON-RPC client, event router, turn collection, and installed-schema adapters.
- `src/messaging/`: MCP ingress, strict caller-bound tools, envelope framing, synchronous/asynchronous/group services, FIFO scheduler, retries, leases, and recovery.
- `src/store/`: SQLite migrations and repositories for identities, messages, attempts, ACLs, audit events, inbox state, groups, and membership snapshots.
- `src/cli/`: explicit operator registration, replacement, pause/disable, ACL, group, health, and backup commands.
- `tests/unit/` and `tests/integration/`: deterministic protocol, security, scheduling, recovery, store, service, CLI, MCP, and real-host coverage.
- `tests/runtime/`: bounded real participating-thread smoke tests; the async smoke also exercises group fan-out.
- `generated/codex/`: exact installed-version protocol artifacts and drift manifest.

## Invariants to preserve

- Never accept sender identity or raw recipient thread IDs from model tool arguments.
- Never run a second app-server owner for a participating live thread.
- Normal delivery uses `turn/start`, waits for an idle recipient, and never silently steers.
- Persist before dispatch; use message IDs, generations, idempotency, FIFO queues, and cross-process leases to prevent duplicate or stale delivery.
- Extract only authoritative final agent messages for synchronous replies; never expose reasoning or tool output.
- Asynchronous and group recipient output never creates a new edge automatically.
- Re-check ACLs and current identity readiness when creating or retrying an edge.
- Administrative registration, rebinding, ACL, and group membership operations stay outside MCP.
- Fail closed for unattended approvals and protocol drift; redact credentials, content, and sensitive paths from logs/errors.

## Verification and operations

The standard gate is `npm.cmd ci`, followed by `npm.cmd run verify:all`, `npm.cmd run test:coverage`, and `npm.cmd run smoke:package`. `docs/evidence/mvp-real-thread-exchange.md` records the accepted real synchronous exchange, and `docs/evidence/final-verification.md` records the final clean gate plus real asynchronous/group message and turn IDs. Use `codex-inter-agent health` after startup and upgrades, and create a hot backup before schema or package changes.

Compatibility limits, upgrade instructions, rollback, release checks, and current gaps are in `MAINTENANCE.md`. Installation, runtime operations, security assumptions, and feature semantics are in the sibling documentation files.
