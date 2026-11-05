# Feishu API validation — 2026-11-04

Status: **live API validation passed for the tested app/user/tenant**. The original API proof below was followed by a built local MCP and real stdio-client validation, described next. This is a local alpha, not a public production release.

## Built MCP validation

The built CLI completed identity-bound OAuth and stored credentials in the macOS keychain. A real SDK client launched `dist/cli.js serve --stdio` in a separate process, discovered the expected tool policy, read the temporary chat fixture, rejected an unapproved write, then completed document creation with content, text/block reads, targeted replacement and readback, deletion and a post-delete read confirming a deleted/not-found error. The disposable document needed no pending cleanup.

Token-free result: `.runtime/mcp-stdio-live.json`. Credential-free smoke evidence: `.runtime/mcp-stdio-smoke.json`. A separate real macOS keychain write/read/delete probe passed. See [implementation](IMPLEMENTATION.md), [setup](review/setup.html) and [security boundaries](../SECURITY.md). The trusted fixture runner explicitly signs only its own newly created test-document operations; it is not evidence of cryptographic human presence.

### Attachment implementation — 2026-11-05

Attachment metadata is now included in message reads, with `messages_read_attachment` for UTF-8 text/code, raster images, PDF text and DOCX text. Automated coverage exercises message/resource binding, visibility-scope checks, fixed-origin user-token downloads, JSON error sanitization, byte limits, encoding errors, malformed/oversized documents, parser cancellation, and actual PDF/DOCX fixtures. A real SDK stdio client discovers the new tool and reads synthetic text/native-image attachments; incorrect keys and path-like input are rejected.

Validation: `npm run check`, `npm test` (40 tests), `npm run test:auth-harness` (5 tests), `npm run test:stdio`, and `npm audit --omit=dev` (zero known vulnerabilities). This does **not** establish live Feishu resource access: live attachment reads were not exercised, and no attachments were uploaded/sent for this change. No new scopes or client configuration changes were made. Reconnect/restart the MCP process after rebuilding.

## Verified

| Capability | Live evidence |
|---|---|
| User OAuth | Confidential-client app-secret exchange succeeded; all nine requested scopes granted |
| Group discovery | Joined groups returned; exact temporary group found |
| Message search | Search restricted to the temporary group returned one result |
| Message history | Latest-message request returned one message |
| Individual message | Get request succeeded for a message ID returned by history |
| Document create | Created one uniquely named disposable modern Docx document |
| Content insertion | Inserted a Unicode text block |
| Document read | Read text and structured blocks; text matched the fixture |
| Document update | Replaced the test block's text |
| Update verification | Reread text contained the updated fixture and not the original |
| Document deletion | Drive delete with `type=docx` returned success; documented effect is recycle-bin deletion |

The temporary group was created through the Feishu desktop UI with only the user as a member. Its sole-member state was checked in the UI before and after API tests. No bot or other people were added. One harmless fixture message was sent through the UI; **this does not validate API message sending**. The group and fixture remain available for future tests.

Only the newly created disposable document was modified/deleted. No pre-existing document was changed. The successful delete call left no pending cleanup ID in the report. Permanent erasure, restoration, trash retention and a separate post-delete read were not tested.

## Authentication finding

- S256 PKCE attempts against the v3 token endpoint failed with `20049`, with both form and JSON encoding.
- Local RFC PKCE-vector and challenge/verifier serialization checks pass. The cause of the provider rejection is not established.
- The user explicitly approved testing the documented confidential-client flow without PKCE. That flow succeeded with the app secret, random state and registered `http://127.0.0.1:52741/callback`.
- Non-PKCE mode requires an explicit harness environment flag; it is not automatically enabled after a PKCE failure. Production authentication needs a separate decision.
- Secrets and access tokens were process-memory-only; no refresh token was requested. Browser password-save prompts were declined. Reports contain no tokens, message bodies or document bodies.

## Not yet verified

- Group history in a normal multi-person group; external/restricted groups and historical visibility cases.
- Direct-message reads, thread replies and pagination edge cases.
- API message send/reply, editing, recall and attachments.
- Document search: `search:docs:read` required approval and was removed; no request was made to that API.
- Shared-document write/delete roles, concurrent edits, idempotency, large/nested documents, tables, media and content fidelity beyond the simple text fixture.
- Token refresh, OS-keychain custody, revocation, Lark-global support or MCP client interoperability.

## Evidence and reproducibility

- Ignored, token-free live result: `.runtime/api-validation.json` (`stage: complete`).
- Earlier token-free PKCE failures: `.runtime/first-oauth-attempt.json` and `.runtime/second-pkce-attempt.json`.
- Helper tests: `node --test scripts/validation-auth.test.ts` — **5 passed**.
- App console: nine user scopes show Added; document-search scope removed; draft 0.1.1 deleted; 0.1.0 remains released with no unpublished changes at the console checkpoint.
- No Git remote, publication, other tenant or other user was involved. Scope grants and successful calls establish only this tested setup, not full parity with everything the user can do in Feishu's UI.
