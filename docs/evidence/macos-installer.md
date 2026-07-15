# macOS installer acceptance evidence

Milestone 20 validation was performed on GitHub's `macos-15` hosted runner because no maintainer Mac was required. Local Windows checks validated the source contract and preserved the existing Windows release; the hosted run supplied the macOS-native acceptance evidence.

## Terminal evidence

- Workflow/run URL: <https://github.com/omrijsharon/codex-inter-agent-messaging/actions/runs/29404306780>
- Commit: `4ff3dd58c0745ea23b46d4a7a3fa6fcfd2f169fa`
- Runner: macOS `15.7.7` (`24G720`), image `macos-15-arm64` version `20260706.0213.1`, runner `2.335.1`
- Runtime: Node.js `22.11.0`, npm `10.9.0`, official standalone Codex CLI/app-server `0.144.2`, protocol digest `00d059e58c3fe4320c38af5bca1070f7a72d06c1598937991b035845e5f57627`
- Repository checks: Prettier, ESLint, strict TypeScript, 93 unit tests, and installed Codex schema drift passed. The portable integration shard passed 11 tests in five files; the one excluded test requires the maintainer workstation's private existing thread and passed in the local 12-test gate instead of copying that history into CI.
- Deterministic installer checks: eight scenarios passed—static source contract, dry-run JSON, source wizard test state, private CLI rejection, missing CLI rejection, incompatible CLI official-recovery plan, conflicting marketplace rejection, and structured staged npm failure with no durable source publication.
- Real install: the manifest-pinned public Codex CLI performed first plugin/CLI installation and same-source refresh in isolated Unicode/spaced `HOME`, `CODEX_HOME`, and Application Support paths. Both plugin builds/validations passed and the smoke reported `cleanup: clean`.
- Native app: Swift compiled arm64 and x86_64 binaries, `lipo` produced `x86_64 arm64`, bundle self-test returned `payloadPresent: true`, `plutil` passed, strict ad-hoc `codesign` verification passed, and `unzip -t` reported no errors.
- Artifact: `codex-inter-agent-messaging-macos-universal-unsigned`, ID `8338405450`, 266,971 bytes, retention through 2026-07-29, GitHub artifact digest `sha256:cce9a512ea413ad53b8988c6c384a7d93c6989c27e1b51f7064a836794a7bd53`.
- Signing/notarization: the ordinary artifact is intentionally ad-hoc signed but unsigned for public distribution. The protected Developer ID/notarization job parsed and was correctly skipped because this was an ordinary push without explicit authorization or Apple credentials; no notarization claim is made.
- Job timing: build/test started `2026-07-15T09:23:21Z` and completed successfully at `2026-07-15T09:25:14Z`; the protected release job recorded `skipped`.
- Cleanup: the macOS smoke deleted its complete temporary home/install tree, and the hosted runner cleanup found no user production state in scope.

The acceptance run used isolated `HOME`, `CODEX_HOME`, installation root, and plugin marketplace state. It did not register agents, bind identities, adopt histories, stop an operator host, or access production peer content.

## Final local regression gate

On Windows at `2026-07-15 12:30:57 +03:00` (Asia/Jerusalem), the final evidence-only tree passed `npm run verify:all`: Prettier, ESLint, strict TypeScript, 93 unit tests, Codex 0.144.2 schema drift, eight Windows backend installer scenarios, four native Windows GUI state scenarios, all 12 integration tests, and production build. `npm run test:coverage` passed all 105 tests at 76.19% lines. Repository plugin validation, the official plugin-creator validator, the 13-tool clean-copy plugin smoke, three-command package smoke, macOS static contract, and `git diff --check` also passed. No real Codex marketplace, registration, identity, host, history, or peer content was mutated by these local checks.
