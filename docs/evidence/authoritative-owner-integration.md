# Authoritative owner integration evidence

## Pinned capability

Codex CLI `0.144.0-alpha.4` documents and exposes `--remote <ws://...>` plus `--remote-auth-token-env <ENV_VAR>` for the interactive TUI, resume, fork, archive, delete, and unarchive surfaces. App-server exposes a loopback WebSocket listener with capability-token authentication. The bridge therefore implements `codex-inter-agent connect [-- <codex arguments>]`: it starts or reuses the authenticated singleton and launches stock Codex against that endpoint while passing the token only in a child-process environment variable.

The signed schema-3 descriptor and authenticated control health record bridge/protocol/installation/database identity, a live ownership generation, host nonce, WebSocket transport, capability-token mode, app-server user agent, endpoint, and process identities. MCP registration sends and verifies the same owner capability after independently completing app-server `initialize`.

## Durable thread authority

Schema 6 stores stable owner mode, installation ID, database ID, and protocol version on both the current agent row and each thread generation. New registrations made through the managed owner are bound automatically. Migrated registrations remain `unverified` until an operator closes independently owned views and runs the confirmed, idle-only `adopt-owner` command. Adoption preserves agent ID, generation, thread ID, workspace, and transcript.

Before any lease, `thread/read`, `thread/resume`, or `turn/start`, delivery requires the recipient binding to match the current host. Resume and reconciliation also require the app-server to return the exact registered thread ID. Failure is terminal `UNSUPPORTED_THREAD_OWNER`; discovery hides unbound/foreign recipients.

## Desktop boundary

No supported authenticated adapter exists for the pinned official Windows desktop's private stdio owner. The public protocol cannot detect a concurrent or later independent desktop owner for a persisted history. Accordingly, no desktop adapter or binary patch is included. `docs/UPSTREAM_OWNER_BINDING_PROPOSAL.md` specifies the missing exclusive claim API, and `docs/CUSTOM_CODEX_FORK_EVALUATION.md` records why a fork is not part of this release.

## Verification ledger

Automated coverage includes descriptor/health capability mismatch, token-bound MCP leases, one-action remote launcher argument isolation, schema 1/3/4/5 migration to schema 6, owner adoption, unbound/foreign recipient rejection before app-server calls, exact thread-ID checking, stale generation, busy queueing, retries, duplicate invocation, approval denial, and caller-bound tool schemas. Real runtime IDs, process counts, supported-surface exchanges, and cleanup observations are appended during the milestone-17 acceptance run.

On 2026-07-14, a clean temporary owner started with ownership generation `5acc164f-4f71-4c01-9a0a-d141a139e544`, resumed and registered existing history `019f6082-fd66-7da2-aa9f-b6461c2c486d` as `prepare-inter-agent-thread`, and exercised `connect -- --version`. A second run sent the stock remote archive client through the wrapper to the same authenticated owner; the intentionally nonexistent session returned `failed to archive session`, demonstrating a remote request without mutating a real history. Both runs stopped the supervisor/app-server pair and removed descriptor and lock.

The automatic topology then completed a real synchronous delivery as message `msg_b898c0de-9edb-47f8-95c1-1df59024986f`, target turn `019f6238-ae9f-7643-be08-8c022abb4f26`, with the authoritative final reply ending `MVP_ACCEPTANCE_OK`. A separate automatic owner completed asynchronous message `msg_5aec0737-c292-40bf-b069-60c6ab47213a` in turn `019f623b-807d-7560-a66c-1616a0b56fc2` and group delivery `msg_b30af303-1741-46bd-855d-8847fbcadc81` under group message `gmsg_3a2a7a34-3226-4c41-8fd1-f3c64907a4d1`. No listed runtime PID, descriptor, lock, runtime temporary directory, or default-data descriptor remained afterward.

The first source-checkout automatic smoke failed safely before delivery because the detached child inherited ambient paths instead of the already-resolved temporary configuration. The launcher now forwards every resolved bridge/app-server/messaging/security setting explicitly. A second source-only attempt showed that a `tsx` supervisor is not a stable detached Windows production host, so source bootstrap now requires the compiled host entrypoint and gives a typed build remediation. The compiled rerun produced the successful IDs above; debug processes and temporary state were explicitly verified and removed.
