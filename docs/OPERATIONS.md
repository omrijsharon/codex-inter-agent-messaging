# Operations

## Normal startup and shutdown

1. Open a new Codex task with the installed plugin and trusted `BRIDGE_AGENT_ID`, or run `codex-inter-agent connect` for a participating CLI target.
2. MCP/CLI bootstrap starts or reuses one hidden owner. Run `codex-inter-agent host status` and require authenticated `ready` health.
3. Run `codex-inter-agent health`; require SQLite `ok`, schema 6, app-server connectivity, and the expected owner identity.
4. When maintenance requires shutdown, close participating clients and run `codex-inter-agent host stop`. The supervisor removes its descriptor and terminates its app-server child.

The host is transport infrastructure only. It never chooses recipients or initiates turns.

The initial idle policy is no automatic shutdown: individual MCP pipes, task exits, app restarts, and idle periods do not stop the host. OS shutdown terminates it normally; the next MCP/CLI process starts a fresh ownership generation. Use `host restart` after a compatible upgrade. Normal stop/restart refuses active deliveries; `--force` is an explicit operator interruption.

```powershell
codex-inter-agent host status
codex-inter-agent host start
codex-inter-agent host stop
codex-inter-agent host restart
```

## Diagnostics

```powershell
codex-inter-agent config
codex-inter-agent health
codex-inter-agent host status
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
codex-inter-agent adopt-owner <agent-id> --generation <current-n> --confirm-agent-id <agent-id>
codex-inter-agent supersede <agent-id>
```

Replacement verifies the new exact thread, atomically increments the generation, and requires typed confirmation. Disabled or superseded identities cannot be silently resumed.

Owner adoption is for migrated/unverified existing histories. Close independent desktop/IDE owners first. Adoption verifies the exact thread is idle through the shared owner and binds its unchanged generation to the stable installation/database/protocol authority. It does not prove against a private owner opened later; supported target tasks continue through `codex-inter-agent connect`.

## Safe backup and migration

Create a hot SQLite backup at a new path:

```powershell
codex-inter-agent backup --output D:\Backups\codex-inter-agent\bridge-2026-07-14.sqlite3
```

The command refuses to overwrite an existing file. Back up the capability token separately only if required for disaster recovery, and protect it as a credential. Do not copy a live database, WAL, and SHM independently with ordinary file-copy commands.

Migrations run transactionally when a newer binary opens the database. Before upgrading: stop MCP clients, run `host stop`, create a backup, record the package/plugin/Codex versions, install one synchronized release, open a new task or run `host start`, and run `health`. To roll back after an incompatible migration, stop all processes and restore the complete pre-upgrade backup with its matching binary/plugin; never edit `schema_migrations` manually.

Plugin disable/uninstall prevents future MCP launches but intentionally retains durable state. Stop the host before removal. Back up first, then remove `%USERPROFILE%\.codex-inter-agent` only if permanent data/token/log deletion is intended.

## Codex upgrades

The package pins generated protocol artifacts to Codex `0.144.2`. After changing Codex:

```powershell
npm.cmd ci
npm.cmd run schema:generate
npm.cmd run schema:check
npm.cmd run verify:all
```

Inspect the generated diff, especially thread, turn, approval, and server-request schemas, before deploying the upgraded package.

See [`MAINTENANCE.md`](MAINTENANCE.md) for the full release, dependency, migration, and compatibility procedure.
