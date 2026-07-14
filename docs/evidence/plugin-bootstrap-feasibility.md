# Plugin and automatic-bootstrap feasibility evidence

Evidence date: 2026-07-14 (Asia/Jerusalem)

## Pinned environment

| Component                      | Observed version or contract                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex CLI and app-server       | `codex-cli 0.144.0-alpha.4`                                                                                                                                        |
| Official Codex Windows desktop | Appx `OpenAI.Codex` `26.707.3748.0` (`OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0`)                                                                              |
| Node.js                        | `v22.11.0`                                                                                                                                                         |
| npm                            | `10.9.0`                                                                                                                                                           |
| MCP TypeScript SDK             | `1.29.0` (exact package dependency)                                                                                                                                |
| Plugin manifest                | Current Codex workspace plugin ingestion contract: `.codex-plugin/plugin.json`, strict semver, optional root `.mcp.json`; the manifest has no schema-version field |
| Hooks                          | Current Codex hooks contract documented for the pinned Codex generation; `SessionStart` is supported, asynchronous hooks are not                                   |

`npm run schema:check` confirms the checked-in generated app-server artifacts still match the installed `0.144.0-alpha.4` binary, so regeneration is not required for this milestone.

## Product-surface and process observations

The official desktop app launches its packaged app-server as a private child:

```text
...\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0\app\resources\codex.exe
  -c features.code_mode_host=true app-server --analytics-default-enabled
```

Installed VS Code extensions were also observed with their own `codex.exe app-server --analytics-default-enabled` children. These are independent stdio ownership domains, not clients of the bridge host.

The installed CLI exposes `codex app-server daemon` and `proxy`, but on Windows `codex app-server daemon version` returns:

```text
Error: codex app-server daemon lifecycle is only supported on Unix platforms
```

Therefore the Windows plugin release cannot delegate singleton ownership to Codex's daemon lifecycle. It requires this repository's protected, race-safe launcher.

## Official extension contracts

- Plugin packaging and bundled MCP: <https://learn.chatgpt.com/docs/build-plugins>
- MCP in Codex CLI, IDE, and desktop: <https://learn.chatgpt.com/docs/extend/mcp>
- Hook lifecycle and synchronous `SessionStart`: <https://learn.chatgpt.com/docs/hooks>
- App-server integration and experimental WebSocket transport: <https://learn.chatgpt.com/docs/app-server>
- Open-source surface (CLI/app-server, not the signed desktop UI): <https://learn.chatgpt.com/docs/open-source>

The current official contracts document local STDIO plugin MCP and app-server integration, but no authenticated endpoint, callback, or request proxy to the official desktop app's private live owner. Automatic MCP process startup therefore does not establish authority over a desktop-owned thread.

## Supported ownership decision

| Surface                                            | Plugin/MCP discovery              | Participating-thread ownership in this release                                                            |
| -------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Open-source Codex CLI connected to bridge owner    | Supported                         | Supported                                                                                                 |
| Custom app-server client connected to bridge owner | Supported                         | Supported                                                                                                 |
| Official desktop app                               | Discovery is tested independently | Private desktop-owned threads are rejected unless a future authenticated adapter is documented and proven |
| IDE extension                                      | Discovery is tested independently | Private IDE-owned threads are rejected unless a future authenticated adapter is documented and proven     |

Only the bridge-managed, capability-token-authenticated app-server may call `thread/resume` and `turn/start` for participating threads. The caller-bound MCP is ingress; it never becomes a second owner.

## Caller identity

The documented plugin/MCP process contract does not provide a proven, non-model-controlled current thread ID to the STDIO server. This release therefore retains trusted operator/project configuration through `BRIDGE_AGENT_ID`. The MCP tool schemas contain no sender or caller-thread field, and startup fails if the trusted binding is absent or invalid.

A disposable validated plugin (`codex-inter-agent-lifecycle-probe` `0.1.0`) was installed from a repository-local marketplace and exercised through real `codex exec` tasks. Its STDIO MCP process recorded only environment names matching `CODEX`, `MCP`, `AGENT`, `THREAD`, `SESSION`, `TASK`, or `PLUGIN`; the resulting environment object was empty in every observed main-task, resumed-task, concurrent-task, and subagent process. This is direct negative evidence that the pinned generic plugin launch supplies no trustworthy caller identity through those conventional environment variables.

## Disposable plugin lifecycle probe

The fixture used a validated `.codex-plugin/plugin.json`, root `.mcp.json`, and relocatable `node ./probe.mjs` command. Installation succeeded through `codex plugin marketplace add` and `codex plugin add`, and `codex plugin list` reported it as `installed, enabled` from the repository-local `inter-agent-probe` marketplace.

Observed CLI lifecycle:

| Scenario                                      | Observation                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| New ephemeral task that never called the tool | Codex started, initialized, and listed tools from one MCP process before model work (`pid 30344`)  |
| Two simultaneous tasks                        | Two distinct MCP processes were created (`pid 25924` and `32460`)                                  |
| Persisted task then `codex exec resume`       | Resume created a new MCP process; starts increased from one to two (`pid 25180`, then `30832`)     |
| One task spawning one subagent                | The parent and subagent each received a distinct MCP process (`pid 30416` and `31380`)             |
| CLI process exit/restart                      | Probe processes exited with the owning CLI process; a later CLI invocation created a fresh process |

For each successful start Codex sent `initialize`, `notifications/initialized`, and `tools/list`. The working directory and script path were the installed plugin cache, proving relative command resolution works after installation. The experiment disproves any “MCP starts exactly once” assumption: process multiplicity follows task/runtime boundaries, and the singleton host must be external to every MCP pipe.

The Phase 0 deterministic ownership suite was re-run after the plugin lifecycle experiment: all six tests passed, including active-recipient waiting, a `turn/start` busy race returning to the queue, and bounded busy timeout. This fresh run preserves the real-runtime conclusion already recorded in `spikes/phase0/DECISION_SHARED_HOST.md`: independent app-server owners are unsafe, while multiple MCP clients of one authenticated owner observe authoritative state and serialize work. The automatic-bootstrap contract therefore requires an authenticated healthy-owner check both before and after lock acquisition and forbids a launch on any compatible-owner or incompatible-owner response.

After capture, `codex plugin remove` and `codex plugin marketplace remove` removed the disposable installation. No recorded probe process remained.

The disposable desktop restart/new-task check was not performed inside this active desktop implementation thread because restarting its owner would terminate the work and automating a replacement UI task is expressly outside the project boundary. Official docs state desktop MCP support, but this release makes no stronger empirical desktop tool-discovery claim than the safe process evidence allows. Desktop-owned histories remain a hard delivery no-go regardless of discovery.

## Desktop binding result

Hard NO-GO for direct delivery to official desktop-owned threads on the pinned build. No supported authenticated adapter to the desktop app's live app-server owner was found. A harmless read cannot be attempted through a nonexistent supported endpoint without violating the prohibition on UI automation, log scraping, binary patching, or internal state mutation. The required upstream API is specified in `docs/decisions/0002-automatic-bootstrap-plugin-ownership.md` and the later upstream proposal.
