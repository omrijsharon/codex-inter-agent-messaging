# Release Records

## v0.1.0 MVP record

- Recorded after Milestone 8 acceptance on 2026-07-14 (Asia/Jerusalem).
- Source version: `0.1.0`
- Protocol: Codex CLI `0.144.0-alpha.4`, generated digest `d27d0610897f1e9bc4d344eca4ce89628d5215495c2d3e3cc19dedba00cf6961`
- Acceptance evidence: `docs/evidence/mvp-real-thread-exchange.md`
- Release artifact validation: `npm run smoke:package`

## v0.2.0 asynchronous messaging record

- Recorded after Milestone 10 on 2026-07-14 (Asia/Jerusalem).
- Source version: `0.2.0`
- Adds explicit fire-and-forget delivery, inbox read/acknowledgement, explicit replies, asynchronous status, expiry, and dead letters.
- Preserves the no-coordinator and anti-loop invariants.
- Protocol: Codex CLI `0.144.0-alpha.4`, generated digest `d27d0610897f1e9bc4d344eca4ce89628d5215495c2d3e3cc19dedba00cf6961`
- Release artifact validation: `npm run smoke:package`

## v0.3.0 group messaging record

- Recorded after Milestones 11–12 on 2026-07-14 (Asia/Jerusalem).
- Source version: `0.3.0`
- Adds durable group administration, membership snapshots, independent fan-out, partial outcomes, selective retry, and explicit reply gathering.
- Includes the v0.2.0 asynchronous messaging surface.
- Protocol: Codex CLI `0.144.0-alpha.4`, generated digest `d27d0610897f1e9bc4d344eca4ce89628d5215495c2d3e3cc19dedba00cf6961`
- Release artifact validation: `npm run smoke:package`

## v0.4.0 automatic-bootstrap plugin record

- Prepared for Milestones 13–17 acceptance on 2026-07-14 (Asia/Jerusalem).
- Source/plugin version: `0.4.0`; database schema 6; owner protocol 2; descriptor schema 3.
- Adds repository-marketplace plugin packaging, automatic authenticated singleton bootstrap, stock remote-CLI connection, per-generation owner binding, typed desktop-owner rejection, and lifecycle diagnostics.
- Protocol: Codex CLI `0.144.0-alpha.4`, generated digest `d27d0610897f1e9bc4d344eca4ce89628d5215495c2d3e3cc19dedba00cf6961`.
- Acceptance evidence: `docs/evidence/authoritative-owner-integration.md` and `docs/evidence/v0.4-final-verification.md`.
- Release artifact validation: `npm run plugin:validate`, `npm run smoke:plugin`, and `npm run smoke:package`.

## Unreleased cross-platform installer record

- Adds the Windows native GUI and macOS 13+ native installer surfaces without changing package/plugin version `0.4.0`.
- macOS artifacts are built and tested on GitHub's `macos-15` runner against manifest-pinned Codex CLI `0.144.2`.
- Ordinary artifacts are explicitly unsigned for public distribution; a distinct protected workflow can produce a Developer ID signed and Apple-notarized artifact when maintainer credentials are configured.
- Acceptance evidence: `docs/evidence/macos-installer.md` and `docs/evidence/installation-wizard.md`.

This file is the repository-local release record. No remote tag or publication is implied.
