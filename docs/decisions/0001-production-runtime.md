# ADR 0001: TypeScript on Node.js for the production runtime

- Status: accepted
- Date: 2026-07-14

## Decision

Build the bridge in strict TypeScript using Node.js 22.11 or newer. Compile to ESM JavaScript and keep exact dependency versions in `package-lock.json`.

## Evidence

The Phase 0 implementation already proved app-server JSON-RPC correlation, authenticated WebSocket transport, MCP stdio behavior, concurrent event handling, pending recovery, and shared-host queueing in Node.js. Codex `0.144.0-alpha.4` generates authoritative TypeScript protocol declarations, so TypeScript can consume installed-version types without hand-maintained protocol models. Node's event loop also matches the required continuously reading, non-blocking transport design.

Python offers no countervailing advantage in the spike evidence and would require rewriting the proven transport and fixtures before adding production reliability.

## Consequences

- Production code uses strict TypeScript, ESM, Node's testable asynchronous primitives, and generated Codex protocol types.
- Node.js 22.11 and npm 10.9 are the recorded minimum versions because they are the versions used by the passing Phase 0 environment.
- Codex protocol generation and drift checks are part of normal verification.
- SQLite, MCP SDK, and other runtime dependencies will be added only when their implementation milestones require them.
