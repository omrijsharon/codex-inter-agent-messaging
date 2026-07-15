# Maintenance and compatibility

## Supported baseline

- Package/plugin release: `0.4.0`
- Database schema: `6`
- Bridge owner protocol: `2`; signed descriptor schema: `3`
- Codex CLI/app-server: exactly `0.144.2`, per `generated/codex/manifest.json`
- Node.js 22.11+ and npm 10.9+
- Release-validated OS: Windows

Linux and macOS are not release-validated. Portable Node/SQLite code is not sufficient: singleton process lifetime, permissions, native SQLite packaging, paths, and real app-server/plugin smoke must pass before support is claimed.

| Package line | Latest schema | Upgrade support                                           |
| ------------ | ------------: | --------------------------------------------------------- |
| v0.1.x       |             3 | Forward to v0.4/schema 6                                  |
| v0.2.x       |             4 | Forward to v0.4/schema 6                                  |
| v0.3.x       |             5 | Forward to v0.4/schema 6; registrations become unverified |
| v0.4.x       |             6 | Current; owner protocol 2 and descriptor schema 3         |

Migrations are ordered, transactional, body-checksummed, and forward-only. Unknown future versions and changed recorded migration names/bodies are rejected.

## Known limitations

- All participating recipient tasks must use the bridge-managed app-server owner. The stock CLI workflow is `codex-inter-agent connect`.
- Official desktop/IDE private owners have no supported authenticated adapter on the pinned build. Plugin discovery alone does not make those histories safe targets.
- The public protocol cannot detect a private owner opened after an operator adopts a history. This requires the upstream owner-claim API proposed in `UPSTREAM_OWNER_BINDING_PROPOSAL.md`.
- `BRIDGE_AGENT_ID` is trusted project/profile configuration shared by a task tree; generic plugin MCP startup exposes no authenticated current thread ID or distinct subagent identity.
- The supported deployment is one trusted local OS user. Remote `wss:` is expert-only.
- SQLite is not encrypted at rest; audit events are not externally tamper-evident.
- There is no human approval UI, multi-user administrator role, network metrics exporter, or automatic audit purge.
- Context compaction is operator-driven. The bridge never silently forks, clears, edits, or rebinds a saturated thread.
- Async/group recipient output never creates a new messaging edge. Replies and caller-side synthesis remain explicit.
- The detached singleton has no automatic idle shutdown in v0.4; authenticated lifecycle commands own stop/restart.

## Routine dependency update

1. Record Node, npm, Codex, package/plugin, schema, owner-protocol, and descriptor versions.
2. Update exact dependencies and the npm lockfile with the supported npm version.
3. Run `npm.cmd ci`, `npm.cmd run verify:all`, coverage, plugin build/validate/smoke, installer smoke, and package smoke.
4. For transport/scheduling/ownership changes, run the bounded bootstrap matrix and real synchronous/async/group scenarios.
5. Review the threat model, release notes, redaction, packaged contents, process cleanup, and native dependency provenance.

## Codex protocol update

1. Install the intended Codex version and run `npm.cmd run schema:generate`.
2. Review initialize, thread status/read/resume/list, turn start/completion, item completion, approval, server-request, and remote transport changes.
3. Update adapters/fixtures without weakening validation.
4. Run schema drift and the complete clean gate.
5. Run authenticated shared-owner, remote CLI, plugin, and real-thread tests.
6. Record the exact Codex version and generated digest. Compatibility remains exact until this procedure passes.

## Database migration, restore, and rollback

Tests cover schema 1, 3, 4, and 5 upgrades to schema 6. Schema 6 preserves legacy identity/thread/generation/workspace data but marks old registrations `unverified`. Close independent owners and run confirmed idle-only `adopt-owner` before delivery.

Before upgrade, stop caller MCP clients and the host, create a hot backup at a new path, and record matching package/plugin/Codex versions. Upgrade one synchronized release, start it, run `health`, and adopt only intended histories. To roll back, stop all processes and restore the complete pre-upgrade backup with its matching binary/plugin. Never edit `schema_migrations`, copy only a live SQLite main file, or mix package generations against one database.

## Release checklist

1. Synchronize package, lockfile, central version, plugin manifest/runtime, owner protocol, descriptor schema, store schema, MCP/app-server metadata, and release records.
2. From `npm.cmd ci`, run format, lint, strict types, unit/integration/security/recovery/migration tests, coverage, schema drift, and production build.
3. Build/validate the plugin; inspect relocatable runtime, forbidden-state/secret scan, clean-install smoke, marketplace metadata, and native dependency. Run `test:installer`, `test:installer:gui`, the isolated two-pass `smoke:installer`, and package smoke.
4. Run three clean auto-starts, reuse, concurrent MCP start, crash recovery, ownership rejection, remote CLI connection, and every claimed real delivery surface.
5. Verify logs, processes, handles, descriptors, locks, and temporary files after every runtime scenario.
6. Update release notes, compatibility/rollback, handoff, evidence, and the plan ledger. Publication/tagging remains an explicit operator action.

## Installer maintenance

`INSTALL.cmd` is intentionally a small stable launcher. No arguments opens `scripts/install-wizard.ps1`; explicit arguments retain console/automation compatibility through `scripts/install-plugin.ps1`. Keep both surfaces synchronized with the six plugin steps, optional official CLI recovery step, manifest-pinned Codex version, marketplace name, plugin selector, minimum runtimes, and uninstall documentation. Installation must remain idempotent for one repository path and fail closed when the same marketplace name resolves elsewhere.

Run `npm.cmd run test:installer` for dry-run, Explorer-style PATH, desktop-only recovery planning, private-binary rejection, Unicode/spaced-path, collision, missing-command, failure-propagation, and batch exit-code coverage. Run `npm.cmd run test:installer:gui` for a real STA window launch plus cancel, success, failure, and custom-data-directory states. Run `npm.cmd run smoke:installer` before release; it uses isolated Codex/npm homes, installs the manifest-pinned official standalone CLI with no Codex command on PATH, performs first plugin install plus refresh, verifies state, removes its user-PATH test entry, and deletes the complete temporary environment.

Do not add identity selection, agent registration, history adoption, host force-stop, data deletion, or Codex internal-state edits to the wizard. Those remain separate operator decisions. Do not update the local plugin by hand-editing Codex configuration; rebuild through repository scripts and reinstall through the supported plugin commands.
