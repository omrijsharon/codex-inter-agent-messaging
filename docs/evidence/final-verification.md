# Final v0.3.0 Verification

Completed on 2026-07-14 at 19:36:29 +03:00 (Asia/Jerusalem) on Windows.

## Clean release gate

The gate began with `npm.cmd run clean` and `npm.cmd ci --no-audit --no-fund`, which installed 299 exact locked packages with zero reported audit vulnerabilities. A new test assertion initially failed lint; it was corrected, and every fail-fast gate below then passed from that clean dependency state:

- `npm.cmd run verify:all`
  - Prettier check: passed
  - ESLint: passed
  - strict TypeScript typecheck: passed
  - unit: 60 tests in 11 files passed
  - integration: 9 tests in 5 files passed
  - installed Codex protocol: `0.144.0-alpha.4`, 1,008 files, digest `d27d0610897f1e9bc4d344eca4ce89628d5215495c2d3e3cc19dedba00cf6961`
  - production ESM build: passed
- `npm.cmd run test:coverage`
  - all 69 tests in 16 files passed
  - statements 80.01%, branches 72.89%, functions 86.44%, lines 82.99%
  - bounded four-worker thread pool completed without the earlier Windows fork-termination warnings
- `npm.cmd run smoke:package`
  - built `codex-inter-agent-messaging-0.3.0.tgz`
  - clean-installed it into a temporary prefix
  - exercised the installed CLI and host help plus MCP module loading
  - verified the installed version and bundled `RELEASES.md`

The deterministic matrix includes identity/ACL security, redaction, approval fail-closed behavior, FIFO/leases, busy deferral, retries, crash/history reconciliation, cancellation, expiry/dead letters, async inbox/reply authorization, group visibility/fan-out/selective retry/synthesis, database backup restore, v1/v3/v4-to-v5 migration, future-schema rejection, and migration checksum drift rejection.

## Final real shared-owner runtime

`npm.cmd run smoke:async` passed in 13.8 seconds against the dedicated `Prepare inter-agent thread` participating history:

- asynchronous message: `msg_e77ea47c-ba32-4169-bd80-ffd38b087af1`
- recipient thread: `019f6082-fd66-7da2-aa9f-b6461c2c486d`
- recipient turn: `019f617c-4717-7271-9904-6998f9b0eb88`
- terminal asynchronous status: `delivered`
- group message: `gmsg_bc5fd82f-3c2b-4f46-9060-b0abc2937995`
- group delivery message: `msg_0382b284-ccee-493a-9e45-81ae22448e37`
- terminal group summary: one `delivered`

The earlier synchronous real acceptance remains recorded in `mvp-real-thread-exchange.md`. Together, these runs exercise the shared host, authenticated transport, real existing-thread turns, synchronous reply extraction, asynchronous output-discard invariant, durable inbox, and independent group delivery without UI automation or session-file mutation.
