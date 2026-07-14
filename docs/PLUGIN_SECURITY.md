# Plugin security and administration boundary

The Codex plugin executes a local Node.js MCP server as the current operating-system user. Installing or updating it therefore grants the reviewed plugin/runtime the same local file and process authority that Codex grants other local STDIO MCP servers. Install only from a trusted marketplace/source and validate the manifest and release artifact before enabling it.

## Trusted identity

`BRIDGE_AGENT_ID` is forwarded from the operator-controlled Codex process or profile environment. It must match one active registered agent in the selected bridge database. Missing, unknown, paused, disabled, superseded, or conflicting runtime/database bindings fail before MCP tools are exposed. Sender identity, caller thread ID, capability tokens, and database paths are not model tool arguments.

The binding applies to one Codex task tree. On the pinned Codex build, subagent MCP processes receive the same explicitly configured environment and are therefore intentionally treated as the same registered principal as their parent task. A subagent cannot select a different identity through a prompt or tool call. Deployments that require each subagent to be a distinct principal are unsupported until Codex supplies trustworthy per-caller metadata to ordinary plugin MCP servers.

## MCP approvals and authority

The plugin requests Codex's `writes` approval mode. Read-only discovery/status tools are annotated read-only. Sending, replying, acknowledging, retrying, and marking inbox content read are annotated as writes. The bridge never interprets peer status as human approval, and recipient turns continue to use `approvalPolicy: never` for unattended side effects.

The model-facing MCP surface contains messaging and status operations only. Agent registration, thread replacement/rebinding, ACL changes, group administration, backups, host force-stop, and data removal remain local operator CLI operations.

## Host and local state

MCP startup calls the same authenticated race-safe singleton bootstrap as the CLI. Locks and descriptors are hints, not authority; the protected capability token, signed descriptor, control nonce, installation/database identity, and app-server initialize exchange prove ownership. Transport is loopback-only by default. Capability tokens, live registries, databases, descriptors, locks, and logs are not plugin metadata or release assets.

The detached host intentionally survives individual Codex tasks and MCP pipes. Plugin disable/uninstall stops new MCP launches but does not silently delete durable data. Use authenticated `codex-inter-agent host stop` before upgrade/uninstall; use `--force` only after reviewing active-delivery risk. Data removal is a separate explicit operator decision.

## Hooks and product boundaries

The plugin does not ship a `SessionStart` hook. MCP startup is already the supported lifecycle trigger, and an additional hook would duplicate launch paths without adding trustworthy caller metadata. A future hook may only invoke the same bounded idempotent bootstrap and may never act as the daemon.

Plugin discovery does not change thread ownership. Official desktop- and IDE-owned histories remain unsupported delivery targets on builds without a documented authenticated adapter to their private live app-server owner. The bridge does not patch binaries, automate UI, scrape logs, or mutate Codex rollout/session storage to bypass that boundary.
