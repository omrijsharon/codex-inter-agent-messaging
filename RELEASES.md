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

This file is the repository-local release record. No remote tag or publication is implied.
