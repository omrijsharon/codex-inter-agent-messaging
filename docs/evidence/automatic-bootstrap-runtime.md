# Automatic singleton bootstrap evidence

Completed on 2026-07-14 (Asia/Jerusalem) on Windows with Codex CLI/app-server `0.144.0-alpha.4`, Node.js `22.11.0`, and bridge version `0.3.0` before the release-version bump.

## Implementation checks

The automatic bootstrap implementation now includes:

- stable per-user installation and database identities under the trusted bridge data directory;
- signed strict descriptors with separate protected capability tokens, atomic publication, corruption quarantine, and nonce-checked removal;
- an atomic `open(..., "wx")` startup lock with bounded backoff, diagnostic owner records, conservative stale recovery, and nonce-safe release;
- authenticated control health that echoes host/installation/database/protocol identity, reports uptime, bootstrap mode, MCP leases, active deliveries, and recovery result;
- detached hidden Windows startup with closed MCP stdio, double-checked locking, exact-version refusal, and bounded authenticated readiness;
- explicit `host status`, `start`, `stop`, and `restart` commands using the same lifecycle implementation as MCP startup;
- expiring token-bound MCP client leases independent of host authority or lifetime;
- active-delivery shutdown refusal unless the local operator explicitly uses `--force`;
- fail-closed stale-owner recovery that never kills from a PID alone. An orphan child is terminable only when the signed descriptor verifies, its supervisor is gone, and the app-server endpoint authenticates with the protected capability token.

The selected lifetime is a detached per-user singleton with no automatic idle shutdown. Individual CLI tasks, MCP pipes, and subagents can exit without stopping it. Explicit authenticated operator shutdown, upgrade restart, OS termination, or uninstall owns lifecycle.

## Deterministic verification

- Descriptor suite: 8 tests passed.
- Startup-lock suite: 7 tests passed.
- Control/bootstrap focused matrix plus multiprocess test: 26 tests passed.
- Final unit suite: 85 tests in 15 files passed.
- Final integration suite: 11 tests in 6 files passed.
- Strict TypeScript typecheck passed.
- ESLint passed after correcting the initial lint findings in a request-buffer type and test promise fixtures.
- Prettier check and `git diff --check` passed.

The deterministic matrix covers healthy reuse, missing host, two/three concurrent starters, slow launch, launch failure, stale/corrupt descriptors, invalid signatures, wrong control token, incompatible versions, startup and lock timeouts, permission failures, stale lock owner validation, nonce-safe release/removal, client leases, shutdown identity mismatch, active delivery refusal, and forced shutdown.

The multiprocess integration fixture launched three separate Node/tsx bootstrap workers against one real temporary filesystem location. Exactly one worker launched the fake authenticated owner, all returned `multiprocess-host-nonce-0001`, one caller reported `reused: false`, later callers reused it, and a later process still reused the owner after every original worker exited.

## Real Windows runtime matrix

### Clean single start and stop

The CLI started a detached supervisor `30948` and Codex app-server child `772`. Authenticated status returned matching nonce `31a9fa2b-6c92-4a01-90e0-6fb656f54e2e`, owner mode `bridge-managed`, zero active clients/deliveries, and bootstrap mode `mcp-or-cli`. The child command used an argument array and a protected token-file path; no token appeared in process arguments. `host stop` removed the descriptor and lock, and both processes were confirmed gone.

### Three simultaneous starters

Launcher processes `4540`, `20064`, and `31816` invoked `host start` concurrently from a fully stopped temporary data directory. All three returned nonce `b952e57f-9938-4d3c-87a2-42b5b4b4c5ee`; exactly one reported `reused: false`. Only supervisor `31188` and app-server child `30232` existed, and no startup lock remained. Authenticated stop removed the descriptor and both processes.

### Supervisor crash and recovery

The first host used supervisor `13744`, app-server `27936`, and nonce `d1a5076d-2558-4ac6-bfe6-cc3a78f185ac`. After a forced supervisor crash, Windows also reaped its non-detached child but left the signed descriptor. The next start classified and removed the stale signed descriptor under the startup lock, then launched supervisor `31060` and child `28568` with nonce `a082ef40-fd9c-4d17-b776-3401f63be71a`. Health reported `lastRecoveryResult: stale-descriptor-removed`. The old processes were absent, the lock was absent, and final authenticated stop removed the new descriptor and both new processes.

No scenario left a visible console, launcher, supervisor, app-server, lock, or descriptor after its documented stop path. Capability tokens and installation/database files intentionally remain as protected per-user state until uninstall or explicit data removal.
