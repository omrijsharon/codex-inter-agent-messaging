# Troubleshooting

| Symptom                          | Check                                               | Resolution                                                                                                                                     |
| -------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Messaging tools are missing      | MCP entry and client refresh                        | Install `codex-inter-agent-mcp` in the caller's trusted project/profile and restart or refresh the client.                                     |
| `shared app-server is not ready` | Host terminal and `connection.json`                 | Start `codex-inter-agent-host`; do not hand-edit a stale descriptor.                                                                           |
| Caller identity failure          | `BRIDGE_AGENT_ID` and `codex-inter-agent show <id>` | Bind one registered stable ID in trusted process configuration. Never add a sender tool argument.                                              |
| Recipient unavailable or stale   | Agent status/generation                             | Resume the registered agent or explicitly replace it after verifying the new exact thread.                                                     |
| Request remains pending          | `get_request_status` and `health` unfinished counts | Poll the same message ID. Busy recipients queue; do not resend without the same idempotency key.                                               |
| Busy recipient                   | Shared owner live status and leases                 | Let the unrelated turn finish. Normal delivery never steers it. Inspect expired lease counts if it never progresses.                           |
| Approval denied                  | Recipient attempted a side effect                   | v0.1 declines unattended elevation. Reframe the request without the side effect or perform it through an explicitly human-authorized workflow. |
| Timeout or disconnect            | Host logs and app-server health                     | The scheduler retries transient failures and reconciles by client message ID. Use status recovery before considering a new request.            |
| `RECIPIENT_CONTEXT_EXHAUSTED`    | Recipient context                                   | Compact through a supported operator workflow, then explicitly retry. The bridge will not fork, clear, roll back, or rebind automatically.     |
| Wrong capability rejected        | Token path/process ownership                        | Ensure host, CLI, and MCP processes use the same protected data directory. Never paste the token into model-visible text.                      |
| Schema drift                     | `npm.cmd run schema:check`                          | Regenerate against the installed Codex version, inspect adapters, and rerun the full suite.                                                    |

If `health` reports database corruption, stop all bridge processes, preserve the affected files for diagnosis, restore a known-good backup to a new path, and validate it before changing the configured database path.
