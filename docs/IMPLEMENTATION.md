# Implementation status

## Local alpha delivered

TypeScript 7 native compiler, Node 24, MCP SDK v2 and Zod. Direct Feishu API integration only. The package stays private, with no remote or public license claim.

| Boundary | Files |
|---|---|
| CLI and stdio | `src/cli.ts`, `src/server.ts` |
| OAuth and identity | `src/oauth.ts` |
| Keychain and refresh serialization | `src/credentials.ts` |
| Fixed-host bounded requests | `src/http.ts` |
| Message/Docx adapters and cursors | `src/services.ts` |
| Signed local write operations | `src/operations.ts` |
| Policy/schema/error/lock primitives | `src/core.ts` |

Nine read tools are exposed by default. Five additional tools expose document preparation, inspection and commit only when writes are explicitly enabled. No tool approves writes, sends messages, searches documents, obtains bot tokens, joins chats or makes arbitrary authenticated requests.

The SDK's stdio-era adapter supports modern and legacy openings. Automated tests use a real SDK client in a separate process, not direct handler calls only. Live fixture tests likewise go through the built CLI and MCP transport; their trusted test-side approval signer is explicit and scoped to newly created disposable content.

## Authentication decision

S256 PKCE is the CLI default. `--auth-mode confidential` explicitly chooses app-secret OAuth without PKCE; it succeeded in the tested Feishu China account after S256 attempts returned 20049. A default profile was connected through the built CLI and stored in the macOS keychain. The temporary memory-only validation harness is retained as evidence, not used by the actual server.

No offline scope was added. Access-token expiry therefore needs re-login. Offline refresh is implemented with keychain-backed uncertain-state marking and cross-process serialization, and tested with mocks, but not live-validated. A new login invalidates outstanding drafts and requires restarting server processes. Provider-side authorization revocation is separate from local logout.

## Evidence

- `npm test`: **30 passed**, covering unit/security and subprocess stdio-client tests, including a legacy 2025-11-25 initialize/tools-list exchange.
- `npm run test:stdio`: credential-free built-CLI smoke test.
- `npm run test:stdio -- --live --live-crud`: **14 live checks passed**, including rejection of an unapproved write and post-delete inaccessibility; explicitly authorized fixture-only Feishu integration test. Result is `.runtime/mcp-stdio-live.json`.
- `node dist/cli.js doctor --profile build-check --probe-keychain`: real macOS credential storage round trip, synthetic probe removed afterward.
- `npm audit`: clean at the build checkpoint.
- Native compiler and lockfile pin runtime/dependency choices. No dependencies installed via project install hooks.

See [SECURITY.md](../SECURITY.md) for limits: same-user OS access is outside the MCP approval boundary; TTY checks do not prove human presence, pending content is private-file rather than independently encrypted storage, block replacement can replace formatting within the selected block, and revision checks are not proven transactional compare-and-swap.

## Remaining work before public release

Choose license/copyright holder and private security contact; native dependency/license review; CI across supported platforms and selected MCP clients; broader live coverage for DMs/threads/multi-person/shared resources, token refresh/revocation, concurrent editing and complex blocks; lifecycle tooling for expired/crash-claimed drafts/receipts; independent security review and package provenance/release governance.

Actual user client configuration is intentionally not edited by this build. Use the command/args/environment in the README or client example; client configuration formats differ.
