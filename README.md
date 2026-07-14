# Codex Inter-Agent Messaging

An on-demand tool for registered Codex agents to message another participating persistent thread and receive its final reply. Participating clients and per-thread MCP processes share one bridge-managed, capability-token-authenticated app-server; there is no coordinator agent and the bridge never initiates conversations.

The implementation follows [`getting_started_plan.md`](getting_started_plan.md), with architecture and trust boundaries defined in [`CODEX_INTER_AGENT_MESSAGING_BRIDGE.md`](CODEX_INTER_AGENT_MESSAGING_BRIDGE.md).

Setup and operations: [`docs/INSTALL.md`](docs/INSTALL.md), [`docs/OPERATIONS.md`](docs/OPERATIONS.md), [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md), [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md), and [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md).

Post-MVP asynchronous tools and their explicit anti-loop semantics are documented in [`docs/ASYNC_MESSAGING.md`](docs/ASYNC_MESSAGING.md).

Authorized one-to-many fan-out, membership snapshots, partial outcomes, retries, and explicit synthesis are documented in [`docs/GROUP_MESSAGING.md`](docs/GROUP_MESSAGING.md).

## Supported development environment

- Node.js 22.11 or newer
- npm 10.9 or newer
- Codex CLI/app-server matching the generated protocol manifest
- Windows is the currently validated platform

Install exact dependencies:

```powershell
npm.cmd ci
```

## Developer commands

```powershell
npm.cmd run dev -- --help       # run the administrative CLI from TypeScript
npm.cmd run dev:host            # run the shared transport owner from TypeScript
npm.cmd run build               # compile production ESM output
npm.cmd test                    # unit tests
npm.cmd run test:integration    # local integration tests
npm.cmd run test:coverage       # coverage report
npm.cmd run format              # apply formatting
npm.cmd run lint                # static lint checks
npm.cmd run typecheck           # strict TypeScript check
npm.cmd run schema:generate     # regenerate protocol files from installed Codex
npm.cmd run schema:check        # detect Codex version or generated-file drift
npm.cmd run verify              # format, lint, types, unit tests, protocol drift
npm.cmd run verify:all          # verify plus integration tests and production build
npm.cmd run smoke:package       # build, pack, clean-install, and exercise release commands
npm.cmd run plugin:build        # assemble the relocatable production plugin runtime
npm.cmd run plugin:validate     # validate manifest, marketplace, contents, and secret hygiene
npm.cmd run smoke:plugin        # clean-copy MCP/bootstrap smoke from a Unicode path
npm.cmd run smoke:messaging     # bounded real synchronous participating-thread exchange
npm.cmd run smoke:async         # bounded real asynchronous delivery plus group coverage
npm.cmd run smoke:group         # explicit alias for the combined async/group real smoke
npm.cmd run clean               # remove build and coverage output
```

The committed `generated/codex/manifest.json` records the exact Codex version and a content digest over generated JSON Schema and TypeScript files. After a Codex upgrade, run `npm.cmd run schema:generate`, inspect the protocol diff, update adapters/tests, and rerun `npm.cmd run verify:all`.

## Configuration foundation

Configuration is loaded from trusted process environment variables. Defaults are local-only and bounded. The most useful development overrides are:

| Variable                           | Default                   | Purpose                             |
| ---------------------------------- | ------------------------- | ----------------------------------- |
| `BRIDGE_DATA_DIRECTORY`            | `~/.codex-inter-agent`    | Runtime state root                  |
| `BRIDGE_DATABASE_PATH`             | `<data>/bridge.sqlite3`   | Durable store path                  |
| `BRIDGE_LOG_LEVEL`                 | `info`                    | `debug`, `info`, `warn`, or `error` |
| `BRIDGE_APP_SERVER_LISTEN_URL`     | `ws://127.0.0.1:0`        | Shared owner listen address         |
| `BRIDGE_APP_SERVER_TOKEN_PATH`     | `<data>/app-server.token` | Local capability token file         |
| `BRIDGE_SYNCHRONOUS_WAIT_MS`       | `120000`                  | Initial `ask_agent` wait            |
| `BRIDGE_BUSY_WAIT_MS`              | `120000`                  | Maximum active-recipient wait       |
| `BRIDGE_MAX_MESSAGE_BYTES`         | `65536`                   | Peer request size limit             |
| `BRIDGE_ACL_DEFAULT_POLICY`        | `allow`                   | Missing ACL rule: `allow` or `deny` |
| `BRIDGE_MAX_QUEUE_DEPTH`           | `100`                     | Per-recipient unfinished limit      |
| `BRIDGE_MAX_HOP_COUNT`             | `8`                       | Maximum synchronous call depth      |
| `BRIDGE_MESSAGE_TTL_MS`            | `900000`                  | Accepted message lifetime           |
| `BRIDGE_MAX_CONCURRENT_DELIVERIES` | `8`                       | Per-MCP active recipient turns      |
| `BRIDGE_MAX_GROUP_FANOUT`          | `20`                      | Maximum recipients per group edge   |

Non-loopback endpoints require both `wss:` and `BRIDGE_ALLOW_REMOTE_APP_SERVER=true`. Node's normal certificate and server-name verification applies; use the platform trust store or `NODE_EXTRA_CA_CERTS` for an operator-managed CA. The normal and recommended deployment remains authenticated loopback transport.

Pairwise ACL rules are managed by the local operator CLI:

```powershell
codex-inter-agent acl allow <sender-agent-id> <recipient-agent-id>
codex-inter-agent acl deny <sender-agent-id> <recipient-agent-id>
codex-inter-agent acl list
codex-inter-agent acl remove <sender-agent-id> <recipient-agent-id>
```

The administrative CLI is deliberately absent from MCP. Access is authorized by the local OS account that owns the bridge data directory and capability token. See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for trust boundaries and residual risks.

Unencrypted WebSocket configuration is rejected unless it is loopback. Default structured logs redact credentials, peer content, workspaces, and sensitive paths while retaining correlation IDs.

## Current implementation boundary

The v0.4.0 implementation adds the installable plugin, automatic singleton bootstrap, stock remote-CLI wrapper, and schema-6 owner binding to the synchronous, asynchronous, group, recovery, security, and administration features. Arbitrary independently owned desktop/IDE histories remain intentionally unsupported targets: supported recipient tasks use `codex-inter-agent connect`, and unbound/foreign generations fail with `UNSUPPORTED_THREAD_OWNER`.
