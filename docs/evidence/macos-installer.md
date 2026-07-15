# macOS installer acceptance evidence

Milestone 20 validation is performed on GitHub's `macos-15` hosted runner because no maintainer Mac is required. Local Windows checks validate the source contract only; this record must not claim macOS acceptance until the pushed workflow reaches a successful terminal result.

## Required terminal evidence

- Workflow/run URL: pending
- Commit: pending
- Runner image and architecture: pending
- Node/npm and manifest-pinned Codex versions: pending
- Deterministic installer scenarios: pending
- Real Codex first install and same-source refresh: pending
- Universal binary architectures, bundle self-test, plist, ad-hoc `codesign`, ZIP, and SHA-256: pending
- Artifact name and size: pending
- Signing/notarization state: ordinary artifact is intentionally unsigned for public distribution; protected job not requested unless recorded otherwise
- Cleanup: pending

The acceptance run must use isolated `HOME`, `CODEX_HOME`, installation root, and plugin marketplace state. It must not register agents, bind identities, adopt histories, stop the operator's host, or access production peer content.
