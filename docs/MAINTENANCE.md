# Maintenance and Compatibility

## Supported baseline

- Package release: `0.3.0`
- Database schema: `5`
- Codex CLI/app-server: exactly `0.144.0-alpha.4`, as recorded in `generated/codex/manifest.json`
- Node.js: 22.11 or newer
- npm: 10.9 or newer
- Validated operating system: Windows

Linux and macOS are not yet release-validated. The implementation uses portable Node.js and SQLite APIs, but host process lifecycle, permissions, path handling, and package entrypoints must pass the same clean-environment and real app-server smoke tests before either platform is declared supported.

Package/schema compatibility is:

| Package line | Latest schema | Upgrade support          |
| ------------ | ------------: | ------------------------ |
| v0.1.x       |             3 | Forward to v0.3/schema 5 |
| v0.2.x       |             4 | Forward to v0.3/schema 5 |
| v0.3.x       |             5 | Current                  |

The current binary applies missing migrations in order and rejects unknown future schema versions, changed migration names, and changed recorded migration checksums. There is no down-migration.

## Known limitations

- All participating clients and caller-bound MCP processes must use the one bridge-managed shared app-server owner.
- Each stable caller identity requires a trusted MCP process configuration; identity is not a model argument.
- The supported deployment is one trusted local OS user. Remote `wss:` transport is expert-only.
- SQLite state is not encrypted at rest and audit events are not externally tamper-evident.
- There is no human approval UI, multi-user administrator role, network metrics exporter, or automatic audit purge.
- Context compaction is operator-driven. The bridge never silently forks, clears, edits, or rebinds a saturated thread.
- Asynchronous recipient assistant output does not become an automatic reply. Every reply is an explicit tool-created edge.
- Group synthesis is performed by the caller from explicit replies; the bridge does not choose or run a coordinator.

## Routine dependency update

1. Create a working branch and record the current Node, npm, Codex, package, and schema versions.
2. Update exact dependency versions and regenerate `package-lock.json` with the supported npm version.
3. Run `npm.cmd ci`, `npm.cmd run verify:all`, `npm.cmd run test:coverage`, and `npm.cmd run smoke:package`.
4. For transport, scheduling, or envelope changes, also run the real synchronous, asynchronous, and group smoke commands against disposable participating test threads (`smoke:group` is the explicit group alias for the combined async/group runtime scenario).
5. Review the threat model, release notes, diagnostics, redaction tests, and packaged file list before release.

## Codex protocol update

1. Install the intended Codex version and run `npm.cmd run schema:generate`.
2. Review all generated changes, concentrating on initialize, thread status/read/resume/list, turn start/completion, item completion, approval, server-request, and dynamic-tool schemas.
3. Update protocol adapters and fixtures. Never loosen validation merely to make drift checks pass.
4. Run `npm.cmd run schema:check` and the complete verification suite.
5. Run the authenticated shared-owner integration test and real synchronous/asynchronous smoke tests.
6. Record the new exact version and generated digest in release documentation. Compatibility is exact until this procedure passes.

## Database migration, restore, and rollback

Migrations are append-only, ordered, transactional, and body-checksummed. Tests verify in-place upgrades from released schemas 1, 3, and 4 to schema 5, including preservation of legacy agent identity. Before upgrading production state, stop caller MCP processes, use `codex-inter-agent backup` to a new path, record the matching binary and Codex version, then upgrade and run `codex-inter-agent health`.

Periodically restore a hot backup to a separate temporary data directory with the matching package and run `health` against the shared owner. If rollback is required after a schema change, stop all processes and restore the complete pre-upgrade hot backup with its matching package. Never hand-edit `schema_migrations`, copy only a live SQLite main file, or run two package schema generations against the same database.

## Release checklist

1. Confirm `package.json`, `package-lock.json`, `src/version.ts`, and all entrypoint versions match.
2. Start from `npm.cmd ci`; run format check, lint, typecheck, all unit/integration tests, coverage, schema drift, and production build.
3. Run the package smoke test and inspect its generated tarball name/version and three installed entrypoints.
4. Run bounded real-thread smoke tests when the release changes runtime behavior.
5. Update `docs/RELEASE_NOTES.md`, `RELEASES.md`, and the plan evidence with the real completion time.
6. Publish or tag only through an explicit operator action; repository validation does not imply remote publication.
