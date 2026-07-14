# Phase 0 Existing Thread Discovery

Discovered and verified through Codex app-server `thread/list` with title substring filtering, followed by `thread/read` metadata verification. No Codex session or internal database file was used as the discovery API.

| Operator-visible title | Exact thread ID | Stable Phase 0 agent ID | CWD | Status when read |
|---|---|---|---|---|
| `inter-agent` | `019f5f8d-f4f6-79c1-8ce3-4d767b906934` | `inter-agent` | `C:\Users\tamipinhasi\Documents\repos\codex-inter-agent-messaging` | `notLoaded` |
| `Prepare inter-agent thread` | `019f6082-fd66-7da2-aa9f-b6461c2c486d` | `prepare-inter-agent-thread` | `C:\Users\tamipinhasi\Documents\Codex\2026-07-14\thi` | `notLoaded` |

Discovery commands:

```powershell
node phase0-cli.mjs list "inter-agent"
node phase0-cli.mjs list "Prepare inter-agent thread"
node phase0-cli.mjs read 019f5f8d-f4f6-79c1-8ce3-4d767b906934
node phase0-cli.mjs read 019f0270-a4c3-7c71-aaa4-6cc80b5baa06
```

Both `thread/read` responses returned the same exact title/ID pairs and existing thread metadata. Titles were used only for operator discovery; subsequent routing uses the stable agent IDs and exact thread IDs recorded above.

The earlier `Update ESP32S3-CAM webapp` target (`019f0270-a4c3-7c71-aaa4-6cc80b5baa06`) was superseded by explicit user direction after it proved context-exhausted. Its evidence remains in `EVIDENCE.md` and `DECISION.md`; it is no longer an active Phase 0 registry entry.

The tested administrative mapping is stored in `registry.json`. `node validate-registry.mjs` validates stable-ID syntax, unique exact thread IDs, separate display-title fields, active generation metadata, and live app-server `thread/read` agreement for both records.
