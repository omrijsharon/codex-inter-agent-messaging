# Operations

## Normal startup and shutdown

1. Start `codex-inter-agent-host` and wait for its `ready` JSON line.
2. Run `codex-inter-agent health`; require database `ok` and app-server `connected`.
3. Start or refresh participating Codex clients with their caller-bound MCP configuration.
4. Stop participating clients, then press Ctrl+C in the host terminal. The host removes the dynamic connection descriptor and terminates its child app-server.

The host is transport infrastructure only. It never chooses recipients or initiates turns.

## Diagnostics

```powershell
codex-inter-agent config
codex-inter-agent health
codex-inter-agent list
codex-inter-agent acl list
```

`health` checks app-server connectivity, SQLite integrity/schema version, registered generations, live/expired lease counts, per-status message counts, asynchronous failures, group counts, and the total audit-event count. These are local diagnostic counters rather than a network metrics endpoint. It does not print tokens, workspaces, peer bodies, or replies.

Set `BRIDGE_LOG_LEVEL=debug` only for bounded local diagnosis. Structured logs retain correlation IDs while redacting credential/content/path keys and sensitive value patterns.

Structured logs cover host lifecycle plus queued, dispatched, completed, and terminal/dead-letter message outcomes with message, conversation, sender, recipient, group, turn, and attempt correlation where applicable. The durable authoritative lifecycle remains `audit_events` and the linked message tables; retry scheduling and every intermediate database transition are not separate process log lines. Log rotation and retention belong to the process supervisor or redirected-output destination.

Audit events are append-only under normal operation and have no automatic expiry. Retain the database according to the operator's local policy; for archival or deletion, stop clients, create and verify a hot backup, and retain that backup with the matching package/Codex versions. There is no supported command that selectively purges audit rows. Group deliveries are audited through their linked per-recipient message lifecycle and remain attributable through `group_deliveries`.

## Registration lifecycle

```powershell
codex-inter-agent pause <agent-id>
codex-inter-agent resume <agent-id>
codex-inter-agent disable <agent-id>
codex-inter-agent replace <agent-id> --thread-id <new-id> --workspace <path> --generation <current-n> --confirm-agent-id <agent-id>
codex-inter-agent supersede <agent-id>
```

Replacement verifies the new exact thread, atomically increments the generation, and requires typed confirmation. Disabled or superseded identities cannot be silently resumed.

## Safe backup and migration

Create a hot SQLite backup at a new path:

```powershell
codex-inter-agent backup --output D:\Backups\codex-inter-agent\bridge-2026-07-14.sqlite3
```

The command refuses to overwrite an existing file. Back up the capability token separately only if required for disaster recovery, and protect it as a credential. Do not copy a live database, WAL, and SHM independently with ordinary file-copy commands.

Migrations run transactionally when a newer binary opens the database. Before upgrading: stop MCP clients, create a backup, record the current package and Codex versions, install the new package, start the host, and run `health`. To roll back after an incompatible migration, stop all processes and restore the complete pre-upgrade backup with its matching binary; never edit `schema_migrations` manually.

## Codex upgrades

The package pins generated protocol artifacts to Codex `0.144.0-alpha.4`. After changing Codex:

```powershell
npm.cmd ci
npm.cmd run schema:generate
npm.cmd run schema:check
npm.cmd run verify:all
```

Inspect the generated diff, especially thread, turn, approval, and server-request schemas, before deploying the upgraded package.

See [`MAINTENANCE.md`](MAINTENANCE.md) for the full release, dependency, migration, and compatibility procedure.
