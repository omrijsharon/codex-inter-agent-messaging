# Optional custom Codex fork evaluation

## Candidate extension point

If upstream owner claims are not available, the narrowest fork would be based on the exact open-source Codex CLI/app-server revision corresponding to `0.144.0-alpha.4`. The extension belongs in app-server's thread routing and `turn/start` authorization layer, implementing the owner API described in `UPSTREAM_OWNER_BINDING_PROPOSAL.md`. The messaging registry, ACLs, queueing, idempotency, envelopes, and reply extraction remain in this repository so there is only one semantic implementation.

## Comparison

The plugin plus `codex-inter-agent connect` already uses the stock remote TUI contract and requires no Codex source changes. A fork could make owner claims native and eventually support first-party clients that adopt it, but it would not modify the signed official desktop application and would not make private desktop histories safe by itself.

## Cost and decision

A fork adds Rust toolchain/build ownership, platform packaging, executable signing and provenance, release distribution, security response, protocol-schema regeneration, and a rebase/compatibility test for every upstream update. It also risks diverging behavior across stock plugin and forked paths.

Decision for `0.4.0`: do not ship a fork. Maintain the focused upstream proposal and the stock plugin/remote-CLI adapter. Reconsider only if a deployment explicitly accepts the maintenance and distribution cost, pins an upstream commit, and commits to running the full ownership, approval, recovery, and protocol matrix on every rebase.
