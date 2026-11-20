# Feishu API validation — 2026-11-04

Status: **live API validation passed for the tested workflows/app/user/tenant**, not every tool. The original API proof below was followed by a built local MCP and real stdio-client validation. This is a local alpha, not a production-readiness claim.

## Core workflow expansion — 2026-11-20

Added 39 tools (145 total with writes enabled), retaining user-only identity and
the existing write gate. `npm test` passed **253 tests across 14 files**; the
five auth-harness checks and credential-free real-stdio smoke also passed.
New worker coverage includes limited XLSX/PPTX extraction. See
[core workflow coverage](core-workflows.md) for live checks, scope discrepancies,
deferred approvals, corrected primary-calendar RSVP, and retained test artifacts.

## Attachment size-cap follow-up — 2026-11-20

At the user's request, removed the message-attachment download-byte cap and the 350 KB inline-image cap, including images selected from ZIPs. Originals are returned unchanged; there is no automatic resizing/compression. Separate Drive/media/local-file transfers retain their 5 MB bounds, and ZIP expansion, PDF/DOCX parsing, text extraction, timeout/cancellation, scope and source-message binding safeguards remain unchanged. Large original images may still exceed client/model/provider limits or available process memory.

`npm test` passed 206 tests across 13 files. Regression tests read images above the former 350000-byte and 5000000-byte thresholds, including a screenshot uploaded as a file and a ZIP image, and verify byte-for-byte preservation. A real SDK-client/stdio-server test successfully delivered a 5000001-byte image (over 6.6 MB base64). Existing default download bounds still reject oversized resources outside the message reader. These are synthetic-provider tests; the user's actual failing screenshot has not been identified or retried in this session.

## Productivity implementation — 0.2.0, 2026-11-20

Added 88 focused tools, with unchanged user authentication and write opt-in. See the [scope/capability manifest](productivity-coverage.md) for exact implemented/live-tested/blocked boundaries. Automated validation covers 204 tests across 13 files plus five historical auth-harness tests, credential-free stdio smoke, and real-stdio discovery/annotations with writes enabled and disabled.

`node scripts/productivity-live.mjs --live-disposable` exercised only newly created content: Base app/table/field/record operations and views, Sheets metadata/tabs/ranges/renaming/native formula result readback, Drive folder/copy/move/shortcut/upload/download/import/export, comments create/list/resolve, private calendar/event lifecycle, current-user availability, and board-node deletion/empty-board readback. Space/task/tasklist list reads also passed. Provider replies rejected comment reply creation with content-review code **1069302**; no automatic retry or identity fallback was used, and the live runner correctly exited nonzero. Reply update/delete were not live-validated. Wiki writes, task ancillary writes, chat mutations and document-media downloads remain fixture-tested only. No verified board-node update endpoint was found, so none is exposed.

The final local report at `.runtime/productivity-live.json` is dated `2026-11-20T06:14:14.894Z`. All five top-level cleanup requests succeeded (Docx, new folder with disposable descendants, Base, Sheet and calendar); recycling is not permanent erasure or confirmation of asynchronous folder deletion completion. Retained user documents/team resources were not mutated. A separate real stdio live run (`npm run test:stdio -- --live --live-crud`) passed discovery, token-free diagnostics, existing fixture message reads, disposable document create/update/readback/delete and post-delete inaccessibility.

Live tests found and corrected the provider's minimum calendar page size (50), native formula-object encoding instead of literal text, and omitted/null node arrays on empty boards. Legacy Sheets documentation lists broader scopes, but reviewed narrow grants succeeded on this account; other tenants remain subject to their own policy. The new build is ready for MCP-client reconnect to load its expanded tool catalog; existing process tool catalogs are not hot-reloaded by token refresh.

## Persistent-login validation — 2026-11-20

Persistent renewal is now the default; `--temporary` explicitly selects non-renewing credentials. Missing offline grant, refresh token or refresh lifetime fails login before replacing saved credentials. The integrated build passed 101 tests across 12 files, credential-free stdio smoke checks, five historical auth-harness tests and `git diff --check`.

Live reauthorization returned renewable credentials. A controlled probe treated the loaded access token as expired to exercise the normal `SessionManager.token()` rotation path without waiting for natural expiry. Exactly one refresh succeeded, rotated the refresh token, preserved app/user/tenant and login binding, and saved active credentials in the OS keychain. A second token request reused those credentials without another rotation; a read-only chat-list API call succeeded. The already-running MCP independently observed the renewed, unexpired credentials without restart. No live content was changed. Natural long-duration expiry, revoked authorization, and network/crash recovery remain unverified.

## Review-free productivity permission expansion — 2026-11-20

At the user's request, the authorized app console was inspected through Zen. Under **User token scopes / Approval required: No**, 59 additional productivity grants were individually selected and added. The selected-count checkpoint showed 59; the app returned to its published state and new Base rows showed **Added / User token / User-specific access**. No tenant-token grant, HR/attendance/organization administration or document-sharing administration was selected. Calendar management is a broad user-scoped grant; task/comment/attachment and Base grants include content changes/deletion, not just reads.

Separate read-only console checks showed **Approval required: Yes** for `search:docs:read`, `im:message.send_as_user` and `task:task:write`; those were not added or submitted for approval. These classifications are specific to the inspected app/tenant/date. The [explicit permission pack](permission-packs/productivity-user-scopes.json) records the 59 additions plus three already-enabled board/media grants. App enablement does not modify an existing user's OAuth token or implement missing tools; user consent and returned-grant verification are a separate step.

The CLI now accepts repeated explicit `--scope` arguments, with bounded/validated/deduplicated scopes shown on the local form. Missing explicit extra grants fail before replacing saved credentials. Default login scopes remain unchanged. `npm test` passed 106 tests, including explicit-scope construction and successful/missing-grant callback cases; TypeScript checks, credential-free stdio smoke and diff checks passed.

The user completed Feishu consent. Local token-free verification and the already-running MCP confirmed all 62 explicit extras and 77 total requested scopes were granted, the four excluded grants were absent, access was unexpired and refresh credentials remained active/usable. A metadata read of the existing test document succeeded without restarting the MCP. No newly permitted API workflows were exercised beyond this existing read; grants must not be reported as delivered feature support.

## Direct document writes without approval — 2026-11-20

Legacy prepare/commit tools are now hidden by default and exposed only when writes and `BETTER_FEISHU_MCP_ENABLE_LEGACY_APPROVALS=1` are both enabled. Direct tools retain user scopes, resource ACLs, revision preflight, image checks and write opt-in. Explicitly enabled legacy drafts still require exact CLI approval and cannot be replayed. Client tool-permission prompts are separate from this server workflow.

The integrated build passed 102 tests across 12 files. The real-stdio live CRUD runner, with legacy tools explicitly disabled, discovered only direct write tools, created a disposable document, read its text/blocks, replaced one text block without local approval, verified readback, deleted that same fixture to the recycle bin and verified it was inaccessible. All 13 reported checks passed; no pre-existing document was changed. The fixture needed no pending cleanup.

## Live attachment reads — 2026-11-20

At the user's request, the running MCP read existing attachments in one authorized group using its existing user login. A Markdown file from another participant downloaded and parsed successfully (5,725 bytes; not truncated). A ZIP uploaded by the authorized user downloaded successfully (13,525 bytes); listing returned 15 entries and 22,787 bytes of declared expansion, and an exact `README.md` entry read returned 1,199 bytes of untruncated text. The tool rechecked message/resource binding before each download. No attachment bodies or resource identifiers are retained in this validation record; nothing was uploaded, executed, extracted or saved to disk.

The adapter uses the authorized user access token for fixed-origin GETs, with no tenant-token fallback. This establishes working user-token Markdown and ZIP listing/entry reads for the tested app/user/tenant/group despite the reviewed public download reference listing tenant-token support only. It does not establish all-format or all-chat support: images, PDF/DOCX, DMs, other tenants and native uploads remain unverified live.

## Built MCP validation

The built CLI completed identity-bound OAuth and stored credentials in the macOS keychain. A real SDK client launched `dist/cli.js serve --stdio` in a separate process, discovered the expected tool policy, read the temporary chat fixture, rejected an unapproved write, then completed document creation with content, text/block reads, targeted replacement and readback, deletion and a post-delete read confirming a deleted/not-found error. The disposable document needed no pending cleanup.

Token-free result: `.runtime/mcp-stdio-live.json`. Credential-free smoke evidence: `.runtime/mcp-stdio-smoke.json`. A separate real macOS keychain write/read/delete probe passed. See [implementation](IMPLEMENTATION.md), [setup](review/setup.html) and [security boundaries](../SECURITY.md). The trusted fixture runner explicitly signs only its own newly created test-document operations; it is not evidence of cryptographic human presence.

### Attachment implementation — 2026-11-05

Attachment metadata is now included in message reads, with `messages_read_attachment` for UTF-8 text/code, raster images, PDF text and DOCX text. Automated coverage exercises message/resource binding, visibility-scope checks, fixed-origin user-token downloads, JSON error sanitization, byte limits, encoding errors, malformed/oversized documents, parser cancellation, and actual PDF/DOCX fixtures. A real SDK stdio client discovers the new tool and reads synthetic text/native-image attachments; incorrect keys and path-like input are rejected.

Validation: `npm run check`, `npm test` (40 tests), `npm run test:auth-harness` (5 tests), `npm run test:stdio`, and `npm audit --omit=dev` (zero known vulnerabilities). This does **not** establish live Feishu resource access: live attachment reads were not exercised, and no attachments were uploaded/sent for this change. No new scopes or client configuration changes were made. Reconnect/restart the MCP process after rebuilding.

### Native flowchart-board implementation — 2026-11-09

Added `documents_add_board` for a revision-checked Docx append followed by Mermaid import as native editable nodes, plus `boards_get_nodes` for bounded readback. `login --document-boards` explicitly requests board-create/read user scopes; default login scopes are unchanged. No new dependency or generic authenticated HTTP tool was added.

`npm test` passed **94 tests in 12 files**, including real stdio creation/readback against a synthetic provider. Coverage checks user-only credentials, write/scope gates before mutation, stale revisions, source/ID/page validation, non-retried failed imports, uncertain creation, recovery IDs and untrusted node reads. Run the OAuth callback test only when no interactive login is waiting: both bind the registered local callback port.

The user authorized both board user-token scopes. After rebuilding and reconnecting the MCP, `documents_add_board` appended the requested PCB task flowchart to the newly created task document. `boards_get_nodes` verified **27 native nodes: 15 shapes and 12 connectors**, including the extraction-clearance and support-before-release guards. A subsequent document-block read verified the embedded board token. No other document was changed or deleted. Visual rendering, shared-document races and live partial-failure recovery remain unverified.

The requested revision was created as a second board and verified before removing the original: **55 nodes, including nine decision diamonds, 12 action shapes, three terminators and 31 connectors**. Removal used a one-off, user-authorized Docx block API call with an observed revision and exact old-block check; no board editing/deletion tool was added. Final document readback confirmed exactly one embedded board. In-place node/source editing remains outside the MCP feature scope.

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
