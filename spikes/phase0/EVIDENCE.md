# Phase 0 Evidence

## Toolchain baseline

- Captured: 2026-07-14 12:12:45 +03:00 (Asia/Jerusalem)
- Codex CLI/app-server: `codex-cli 0.144.0-alpha.4`
- Node.js: `v22.11.0`
- npm: `10.9.0` (invoked as `npm.cmd` because the local PowerShell execution policy blocks `npm.ps1`)
- Platform: Windows PowerShell

## Version-matched protocol generation

Commands:

```powershell
codex app-server generate-json-schema --experimental --out spikes\phase0\generated\app-server-schema
codex app-server generate-ts --experimental --out spikes\phase0\generated\app-server-ts
```

Results:

- JSON Schema files: 337
- TypeScript files: 671
- JSON Schema bundle: `spikes/phase0/generated/app-server-schema/codex_app_server_protocol.schemas.json`
- TypeScript entry point: `spikes/phase0/generated/app-server-ts/index.ts`
- JSON Schema bundle SHA-256: `85EA836927D6CFDD3C68A9BDA17DBA48D2573BBC282AB2D5775A5005E40BC9C3`
- TypeScript entry point SHA-256: `80712D84DB9DCE8D91BF8A5368E66A790B3C8DF4875EB7C18258F405201C372D`

The generated artifacts include experimental methods and fields and are the authority for the Phase 0 spike against this installed Codex version.

## Minimal spike harness

Completed: 2026-07-14 12:22:33 +03:00 (Asia/Jerusalem)

Implemented disposable Phase 0 components:

- `app-server-client.mjs`: starts app-server over stdio, performs initialize/initialized, correlates concurrent JSONL requests, continuously records notifications, handles server requests asynchronously, resumes/reads/lists threads, starts turns, and extracts final agent messages.
- `mcp-server.mjs`: minimal MCP stdio server exposing `list_agents`, `ask_agent`, and `get_request_status` without a model-supplied sender field.
- `phase0-cli.mjs`: supported app-server list/search, read, resume, and turn smoke commands.
- `envelope.mjs`: canonical Phase 0 peer envelope.
- `tests/fake-app-server.mjs`: deterministic JSONL/event fixture.

Verification:

```powershell
node --test tests/*.test.mjs
node phase0-cli.mjs list "Update ESP32S3-CAM webapp"
```

- Three Node tests passed: app-server response/event correlation, envelope construction, and MCP initialize/list/minimal ask/status behavior.
- The real app-server command completed successfully and returned supported thread search data, proving the live stdio handshake and request/response path against Codex `0.144.0-alpha.4`.

## Trusted MCP caller identity

Completed: 2026-07-14 12:34:46 +03:00 (Asia/Jerusalem)

The Phase 0 identity binding is operator-controlled per-project MCP process configuration:

- `codex-inter-agent-messaging/.codex/config.toml` launches the server with `PHASE0_AGENT_ID=inter-agent`.
- `ESP32-CAM_MJPEG2SD/.codex/config.toml` launches the same server with `PHASE0_AGENT_ID=update-esp32s3-cam-webapp`.
- `ask_agent` has no model-supplied sender or `from` argument. The MCP process derives the sender only from its host-provided environment.
- Both project paths are marked trusted in the user's Codex configuration, and `codex mcp list` reports `agent_messaging_phase0` enabled in both working directories with environment values redacted.

Two fresh read-only Codex processes were instructed to invoke the MCP server's `list_agents` tool. The structured MCP results proved distinct bindings:

```text
codex-inter-agent-messaging -> self_agent_id: inter-agent
ESP32-CAM_MJPEG2SD          -> self_agent_id: update-esp32s3-cam-webapp
```

The first target-project attempt selected Codex's built-in collaboration `list_agents` tool because it shares the same short name. Repeating the proof with the MCP server explicitly qualified as `agent_messaging_phase0` produced the expected MCP call and trusted identity. Production tool descriptions and tests must account for this selection ambiguity; it does not allow the model to forge the bound MCP identity.

## Existing-thread MCP visibility

Completed: 2026-07-14 12:43:29 +03:00 (Asia/Jerusalem)

The app-server was started once from each named project's working directory, then resumed the exact registered existing thread ID. `mcpServerStatus/list` exposed `agent_messaging_phase0`, and `mcpServer/tool/call` exercised all three tools without asking a model to select among colliding short tool names.

Observed results for both original thread IDs:

- `list_agents`: completed successfully and returned the correct project-bound `self_agent_id` plus both registered agents.
- `get_request_status`: completed successfully with `status=unknown` for the deliberately missing `visibility-probe-missing` ID.
- `ask_agent`: reached the tool and returned the expected validation failure for the deliberately unregistered `visibility-probe-missing` recipient; no recipient turn was created.

The original `Update ESP32S3-CAM webapp` transcript was not recreated. It is currently too large to sample another model turn: both its original model and a newer model failed during pre-sampling remote compaction, and `thread/compact/start` recorded an empty completed turn without reducing the context enough. Direct app-server inventory and tool calls remain functional for the exact thread. This is a real operational limitation to preserve in the Phase 0 decision record and later saturation tests.

After extending the disposable client with project-cwd selection, MCP inventory/call helpers, and manual compaction support, `node --test tests/*.test.mjs` still passed all three spike tests.

## Hard-gate ask attempt and blocker

Attempted: 2026-07-14 12:44:38 +03:00 (Asia/Jerusalem)

The exact existing `inter-agent` thread runtime called `agent_messaging_phase0/ask_agent` for `update-esp32s3-cam-webapp`. The bridge:

- derived `inter-agent` from the operator-controlled MCP process environment;
- resolved the stable recipient mapping to thread `019f0270-a4c3-7c71-aaa4-6cc80b5baa06`;
- constructed the `INTER_AGENT_MESSAGE_V1` envelope;
- started and correlated recipient turn `019f6003-934a-72c2-af8c-675ef873ee93`;
- kept the sender-side tool call open until the terminal recipient event arrived; and
- returned the structured recipient failure to the sender.

Terminal result:

```text
status: failed
error: contextWindowExceeded
message: Error running remote compact task: Codex ran out of room in the model's context window.
```

The target failed before model sampling and produced no agent message, so tasks 1.8–1.10 are not proven. A subsequent `thread/read` shows the failed attempt as an empty completed persisted turn, not a successful persisted envelope/reply exchange.

Recovery attempts that preserved the original thread ID and history all failed:

1. Resume and sample with the thread's recorded `gpt-5.3-codex-spark` model.
2. Resume and sample with `gpt-5.6-terra` at medium reasoning.
3. Invoke supported `thread/compact/start`; app-server recorded an empty completed turn but the next sampling attempt still exceeded context.
4. Resume with `gpt-5.6-terra`, `model_context_window=1000000`, and `model_auto_compact_token_limit=900000`; pre-sampling compaction still failed.

Clearing/rolling back earlier target history would violate the Phase 0 requirement to retain the original transcript. Forking or choosing another target would violate the named-existing-thread requirement unless the operator explicitly changes the gate. Production work must not begin while this essential proof is unresolved.

## User-authorized Phase 0 target replacement

Completed: 2026-07-14 15:08:31 +03:00 (Asia/Jerusalem)

The user explicitly replaced the saturated ESP32 recipient with a dedicated existing thread named `Prepare inter-agent thread`. Supported app-server exact-name discovery and `thread/read` verified:

```text
display title: Prepare inter-agent thread
stable agent ID: prepare-inter-agent-thread
thread ID: 019f6082-fd66-7da2-aa9f-b6461c2c486d
CWD: C:\Users\tamipinhasi\Documents\Codex\2026-07-14\thi
```

The active Phase 0 registry now contains only `inter-agent` and `prepare-inter-agent-thread`. The dedicated CWD has trusted project MCP configuration with `PHASE0_AGENT_ID=prepare-inter-agent-thread`. Live `validate-registry.mjs`, `codex mcp list`, and the three Node spike tests passed.

A real resumed turn on the exact dedicated thread invoked all three tools from `agent_messaging_phase0`. Its structured `list_agents` result returned the correct trusted self identity and both active agents; status and unknown-recipient probes exercised the other tools without delivery. The resumed turn completed successfully.

## Successful dedicated-thread ask

Completed: 2026-07-14 15:10:04 +03:00 (Asia/Jerusalem)

The exact `inter-agent` MCP runtime issued an on-demand ask to `prepare-inter-agent-thread`. The sender-side call stayed unresolved for 5,859 ms while app-server created and completed the target turn.

```text
message_id: msg_c1491a38-839e-425b-b781-528114c0b0cf
conversation_id: phase0-hard-gate-prepare
target_thread_id: 019f6082-fd66-7da2-aa9f-b6461c2c486d
target_turn_id: 019f6087-ec64-7630-ba4a-5a6aa119e5e5
target turn duration: 2,726 ms
target turn status: completed
final agent message: PHASE0_REPLY_OK
```

Supported `thread/read` proves the target transcript persisted the `INTER_AGENT_MESSAGE_V1` user message with `clientId` equal to the message ID, authenticated `from_agent=inter-agent`, `to_agent=prepare-inter-agent-thread`, the peer request, and final agent message `PHASE0_REPLY_OK`.

The direct app-server `mcpServer/tool/call` returned the final answer correctly but did not create a tool-call/result item in the sender transcript. This is expected for the host API and means task 1.10 still requires an actual model-originated MCP call in the sender thread.

## Persisted sender result and bounded recovery

Completed: 2026-07-14 15:13:51 +03:00 (Asia/Jerusalem)

A real resumed sender model turn invoked `agent_messaging_phase0/ask_agent`. Supported `thread/read` verified both sides of message `msg_424d9d81-1ba4-4686-bc36-7205bc468b27`:

- sender turn `019f608a-53b8-7aa0-b9fc-719b4a579bc3` contains the MCP call, completed structured tool result, and final `PHASE0_PERSISTED_OK`;
- recipient turn `019f608a-b098-72f1-acde-101f8734c493` contains the authenticated peer envelope and final `PHASE0_PERSISTED_OK`.

`pending-recovery-probe.mjs` then forced a 1 ms synchronous wait. The first result was `pending` after 174 ms with message ID `msg_d1d5e12a-62dc-41a0-8914-4d33cec37096`. Forty-one status polls on the same MCP process returned the authoritative completed result `PHASE0_PENDING_OK`. Supported target transcript inspection found exactly one recipient turn with that client message ID, proving status recovery did not redeliver.

## Desktop busy-turn test limitation

The repository instructions require Windows Computer Use for a real Codex desktop-started busy-turn test. The installed Computer Use plugin was loaded according to its skill workflow, but the JavaScript control kernel failed before initialization with `failed to write kernel assets: The system cannot find the path specified (os error 3)`. Resetting the control kernel and retrying produced the same failure. No desktop action occurred. Task 1.12 remains unchecked; a CLI-started active-turn experiment is not accepted as a substitute.

## App-server ownership topology

Completed: 2026-07-14 15:24:37 +03:00 (Asia/Jerusalem)

An independent-owner probe started a 20-second target command through one stdio app-server, then inspected and delivered through another. The second owner incorrectly reported the active target as `idle`. The turns overlapped by one second, and supported `thread/read` showed `OWNER_A_DONE` persisted as the first item of Owner B's turn. Independent stdio app-server ownership is unsafe for messaging.

The selected topology is one authenticated local app-server owner shared by per-thread MCP processes. `AppServerClient` now supports capability-token-authenticated WebSocket transport, and `mcp-server.mjs` accepts operator-provided shared endpoint/token environment bindings.

`shared-ownership-probe.mjs` starts one loopback app-server with a temporary 256-bit capability token, connects two separate MCP stdio processes, and exercises the same recipient concurrently. The clean rerun proved:

- the shared owner reported the target `active`;
- the second MCP instance received typed `RECIPIENT_BUSY` and created zero recipient turns;
- Owner A completed with `SHARED_A_DONE`;
- Owner B retried after idle and completed with `SHARED_B_DONE` in exactly one separate turn;
- child processes, socket clients, token file, and temporary directory shut down cleanly.

The probe pins `ws@8.21.0`; `npm audit` reported zero vulnerabilities. Production still requires the planned durable cross-process FIFO scheduler so busy work is queued automatically rather than retried manually.

## Automatic shared-host busy queue

Completed: 2026-07-14 16:36:40 +03:00 (Asia/Jerusalem)

After the user selected bridge-managed shared hosting for participating threads, the Phase 0 MCP delivery path changed from returning `RECIPIENT_BUSY` to waiting on the shared owner's authoritative status. It also requeues a turn-start busy race and returns a bounded `RECIPIENT_BUSY_TIMEOUT` if the configured wait expires.

`shared-ownership-probe.mjs` now starts the second request while the first recipient turn is active and forbids manual retry. Three consecutive real runs passed. The second MCP process remained unresolved during the active turn, then automatically created exactly one later turn and returned `SHARED_B_DONE`. Queue waits were 41,550 ms, 27,184 ms, and 28,096 ms. Every run recorded one turn per message, correct transcript order, distinct final replies, and clean child-process/token cleanup.

Regression evidence:

- `npm test`: 6/6 tests passed, including deterministic busy wait, dispatch race, and timeout cases.
- `pending-recovery-probe.mjs`: returned pending after 288 ms, recovered `PHASE0_PENDING_OK`, and found one matching recipient turn.
- `npm run schema:verify`: 25/25 protocol assertions passed.
- `npm run registry:verify`: both live stable mappings passed.
- `npm audit --audit-level=moderate`: zero vulnerabilities.

The final scoped decision is recorded in `DECISION_SHARED_HOST.md`: GO for production work when all participating clients and MCP processes use the bridge-managed authenticated shared app-server.
