# better-feishu-mcp

A local TypeScript MCP that uses **your Feishu identity** to read messages and online Sheets, and create/read/update/delete modern Feishu documents. Built from scratch against Feishu APIs—not a wrapper around another Feishu MCP or CLI.

**Local alpha.** Real stdio-client message reads and a disposable-document CRUD cycle have passed on the tested Feishu China account. No remote hosting or public package/repository exists. License selection is pending; the package is private.

- **No bot membership in chats.** App/bot registration may be required; adding the bot to a chat is not part of this implementation.
- **No tenant-token fallback.** Unsupported or missing user access fails explicitly.
- **No message sending or document search.** Those scopes required approval and are excluded.
- **Writes off by default.** When enabled, direct document tools use your existing login, without per-edit terminal approval. The old approval workflow remains optional.

For a scannable light-mode overview, open [setup and current status](docs/review/setup.html). See [security boundaries](SECURITY.md) before use.

## Requirements and build

- Node **24 LTS**; macOS keychain tested. Linux Secret Service and Windows credential support are implemented through the native binding but not live-validated here.
- A Feishu China custom app, its user scopes, and your own account consent. There is no universal approval bypass.
- An available OS keychain. No plaintext credential fallback.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run test:stdio
```

`typescript@7.0.2` is the **native Go-based compiler**, invoked as `tsc`. Node runs its JavaScript output. Runtime libraries and dev dependencies are pinned in `package-lock.json`.

## Login

Register exactly this OAuth redirect in Feishu's app Security Settings:

```text
http://127.0.0.1:52741/callback
```

Start the login form in your browser; enter the App Secret there, **not in argv, source, environment examples or chat**:

```sh
node dist/cli.js login --app-id cli_YOUR_APP_ID
```

Login always uses confidential-client OAuth (app secret + state, without PKCE). Agents and users do not need to choose a mode:

```sh
BETTER_FEISHU_MCP_BROWSER=Zen node dist/cli.js login \
  --app-id cli_YOUR_APP_ID
```

The old `--auth-mode confidential` flag is accepted for compatibility, but is unnecessary; `--auth-mode pkce` is rejected. Legacy PKCE credential records can still be read so upgrading does not discard an existing login. State, an exact loopback callback and user consent remain required. On success, the app secret, user tokens and identity binding are stored in the OS keychain. A profile cannot change app/user/tenant without `--replace` or a separate profile.

```sh
node dist/cli.js status
node dist/cli.js doctor --probe-keychain
node dist/cli.js logout
```

No refresh token is requested by default: re-login after expiry. `login --offline` explicitly requests `offline_access` if your app is allowed that scope. Rotation is serialized and marked uncertain before the one-use refresh token is sent; ambiguous failures require re-login, never a blind retry. Live refresh is not yet verified. Logout removes local credentials, not the provider-side grant—revoke that separately in Feishu's App authorization management.

Multiple MCP processes/sessions using the same profile and state directory share the OS-keychain login. Re-login to the **same app/user/tenant** is picked up automatically on their next API call; it does not require restarting or logging in separately in every session. Explicitly switching identity still requires restarting bound MCP processes. Re-login invalidates previously approved legacy drafts. `LOGIN_REQUIRED` due to expiry without a refresh token is different from `RESTART_REQUIRED` due to an identity switch. To avoid routine expiry prompts, enable `offline_access` in the app and explicitly use `login --offline`; persistent renewal is not enabled silently. Use the same state directory across processes so credential refresh shares one lock.

## Connect an MCP client

Use the client's local **stdio** integration. Replace the path below with the actual built repository path; use an absolute Node executable path if your client cannot find Node 24.

```json
{
  "mcpServers": {
    "better-feishu-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/better-feishu-mcp/dist/cli.js", "serve", "--stdio"],
      "env": {
        "BETTER_FEISHU_MCP_PROFILE": "default",
        "BETTER_FEISHU_MCP_ENABLE_WRITES": "0"
      }
    }
  }
}
```

Client configuration formats differ; the important fields are command, args and environment. This project does **not** change your global client configuration. Restart/reconnect after rebuilding, changing server environment or switching identity—not after renewing the same account's login. Protocol-only stdout; diagnostics on stderr. Both modern and legacy stdio openings are served by the SDK adapter.

## Tools

| Read tools | Purpose |
|---|---|
| `auth_status` | Token-free identity, expiry, scopes and write-policy diagnostics |
| `chats_list` | Bounded joined-group listing; not a DM directory |
| `messages_search` | Visible-message snippets/metadata, optionally filtered by chat |
| `messages_history` | Recent group or p2p history with explicit chat ID and visibility |
| `threads_history` | Replies for an explicit thread ID |
| `messages_get` | Retrieve an individual message |
| `messages_read_attachment` | Read a message attachment as text or a native image |
| `documents_get` | Modern Docx metadata and revision |
| `documents_read` | Plain text capped at 100000 characters |
| `documents_blocks` | Structured blocks with opaque, revision-bound cursors |
| `sheets_get` | Spreadsheet metadata from a token or direct Sheets link |
| `sheets_list` | Tab IDs, titles, visibility and grid sizes |
| `sheets_read` | Explicit cell-range reads, up to 10000 cells |

Group history/get/search have passed live tests in the sole-user fixture chat with bot absence verified in the Feishu UI. P2p, thread and normal multi-person group cases remain unverified; scope support does not override tenant or resource restrictions.

### Online Sheets (read-only)

Enable the user scope `sheets:spreadsheet:readonly` in your Feishu app, then log in again using your existing app. Same-account reauthorization is picked up automatically by running MCP processes; reconnect after rebuilding to discover the tools. Existing tokens do not gain the scope automatically. Whether app/tenant approval is required must be checked in your app console; it has not been verified for this scope. No permission settings are changed automatically.

1. Call `sheets_get` with `spreadsheetToken`: either the token or `https://<tenant>.feishu.cn/sheets/<token>`.
2. Call `sheets_list` with the same input to find each tab's `sheet_id`.
3. Call `sheets_read`, for example:

```json
{
  "spreadsheetToken": "SPREADSHEET_TOKEN",
  "sheetId": "TAB_ID",
  "range": "A1:D100",
  "valueRenderOption": "FormattedValue"
}
```

Use explicit ascending A1 cell ranges (or a single cell), not tab titles, whole rows/columns or an entire sheet. Reads are capped at 10000 cells, 2 MB provider responses and 512 KB MCP results; request a smaller range if a byte limit is exceeded. Trailing empty cells may be omitted, and typed/rich cell values are preserved as returned by Feishu. `valueRenderOption` defaults to `FormattedValue`; `UnformattedValue`, `Formula` and `ToString` are also available. Dates request formatted strings. Feishu's API does not support calculated cross-sheet reference or array formula results.

All tools use only your user token and existing resource access, mark spreadsheet content as untrusted, and are available with writes disabled. No sheet writes, Wiki resolution, Base/Bitable access, Excel attachment parsing or sheet search is included. Metadata/tab/range APIs and real MCP stdio are tested with synthetic data; **live Sheets reads remain unverified** pending authorization and a target spreadsheet.

### Message attachments

Message get/history/thread/search results now include an `attachments` array, while preserving the raw message body. Search snippets may omit resource keys: fetch the full message with `messages_get` first in that case. Pass the attachment's exact `resourceKey` and `type`, plus its `messageId` and `visibility`, to `messages_read_attachment`:

```json
{
  "messageId": "om_MESSAGE_ID",
  "visibility": "group",
  "resourceKey": "file_RESOURCE_KEY",
  "type": "file"
}
```

- UTF-8 text/code, Markdown, CSV, JSON, XML and HTML return plain text; nothing is executed or rendered as active HTML.
- PDF and DOCX files return extracted plain text, not their original layout. PDF extraction reads at most 50 pages; scanned PDFs require OCR, which is not provided.
- PNG, JPEG, GIF and WebP return native MCP image content for image-capable clients/models. Use `type: "image"` for image resources.
- Downloads are capped at 5 MB, text at 100000 characters and inline images at 350 KB. Truncated text/page results are marked. Oversized resources fail explicitly rather than being saved to disk.
- Unsupported formats (including spreadsheets, presentations, archives, audio/video and stickers) fail explicitly. No automatic downloads, local paths, OCR, transcription or attachment uploads.

Each read re-fetches the source message to verify the resource key/type. It uses the existing message-read scopes and **only your user token**; resource ACLs and tenant policy can still deny access. All attachment contents are untrusted data. PDF/DOCX parsing runs in a time/heap-limited worker, not an OS sandbox.

Attachment functionality is covered by synthetic API tests, actual PDF/DOCX parsing fixtures and real MCP stdio tests; **live Feishu attachment access is not yet validated**. After rebuilding, reconnect/restart your MCP client/server to discover the new tool.

### Document writes

Set `BETTER_FEISHU_MCP_ENABLE_WRITES=1` **in the MCP server environment**, then reconnect it. Use the same Feishu login as message/document reads—no separate document authentication or local approval is required:

- `documents_create`: title, optional parent folder and content (up to **50 blocks**, 32000 total characters).
- `documents_update`: observed revision plus one append (up to **50 blocks**) or text-block replacement.
- `documents_delete`: observed revision; moves the document to the recycle bin, not permanent erasure.

Read `documents_blocks` before editing to get the revision and block IDs. The same OAuth user token, scope checks, resource ACLs, revision checks and per-target local locks apply. If the existing login lacks a required scope, explicitly reauthorize that same login; there is no additional docs login flow. Direct writes do not create approval drafts or local operation receipts. Failed/uncertain writes are not automatically retried; inspect the document before retrying, especially after a create or append failure.

Enabling writes gives the connected MCP client permission to mutate documents accessible to your account. The server no longer requires terminal confirmation for direct writes; use your client's tool permissions/confirmation settings if you want interactive review.

#### Optional legacy prepare/approve/commit workflow

For clients that still use exact local approvals, the following tools remain available with writes enabled:

- `documents_prepare_create`: title, optional parent folder, optional structured content.
- `documents_prepare_update`: observed revision plus one append or text-block replacement.
- `documents_prepare_delete`: exact document and observed revision; deletion means recycle bin.
- `operations_get`: inspect a pending draft.
- `operations_commit`: execute a locally approved draft once.

Workflow:

1. Read the document and block IDs if editing/deleting.
2. Prepare the exact operation. The tool returns a preview, expiry and structured local CLI command/args.
3. In a **trusted local terminal**, run the approval command, review the preview and type the requested confirmation.
4. Ask the MCP to commit the operation ID. Approval expires after ten minutes and cannot be replayed.

For this local checkout the command is:

```sh
node /absolute/path/to/better-feishu-mcp/dist/cli.js approve OPERATION_ID --profile default
```

No MCP tool can approve a legacy draft. Its approval signatures are bound to payload, target, expiry and login identity using a key held in the OS keychain. Relogin invalidates prior drafts. A model-supplied `confirm: true` is not accepted. This optional process is not required by `documents_create`, `documents_update` or `documents_delete`.

Content creation supports paragraphs, headings, bullets, ordered lists, quotes, code blocks and the inline images described below. Basic paragraph create/read/replace/delete is live-tested; other block types are contract/unit-tested only. No lossless Markdown round trip, table editing, existing-image replacement, Wiki lifecycle or legacy Docs claim. Replacing a block's text replaces its rich-text elements; unrelated blocks are left alone. Revision preflight is **best-effort**, not an atomic multi-user transaction guarantee.

### Inline document images

Create and append operations also support **PNG/JPEG images interleaved with text**, rendered as native Feishu image blocks—not links or attachments. Replacing an existing image, importing HTML/Markdown, and other media formats are not implemented.

```json
{
  "title": "Calibration guide",
  "content": [
    { "type": "heading", "text": "Check the mounting", "level": 2 },
    { "type": "paragraph", "text": "Verify the physical mounting before calibration." },
    {
      "type": "image",
      "path": "/absolute/path/to/01-mounting.png",
      "caption": "Mounting settings — offline menu example"
    }
  ]
}
```

- The path is **on the MCP server machine**, not the remote client. Only canonical absolute regular-file paths are accepted; URLs and symlink components are rejected. Image formats/dimensions are checked from headers, not extensions. The server does not decode or execute image contents.
- Limits: **10 images**, **5 MB each**, **20 MB total** per operation; **20000 pixels per side / 40 million pixels**. No chunked upload or new dependency is needed.
- Direct `documents_create`/`documents_update` calls read and validate all image files before any document mutation, then upload those exact buffers immediately—no separate local approval or draft. Enabling writes and granting media-upload permission authorizes the connected client to upload eligible local images; use client-side permissions if review is needed. The 50-block limit includes both image and text blocks.
- In the optional legacy workflow, preparation reads the files locally without uploading. The preview/CLI approval includes path, upload filename, MIME, byte size, dimensions and SHA-256. Inspect the actual local images before approving. Signed approval binds these details and the content; approval and commit reread images. Modified images require a new draft.
- The sequence is create block → upload to that block (`docx_image`, with the document route token) → `replace_image`. Uploads are serialized and never automatically retried. A partial failure exposes document/block IDs and known uploaded media tokens in the error (and the receipt for legacy drafts); it does not roll back, replay, or silently delete the document.

Image upload requires the additional user scope **`docs:document.media:upload`**. Enable it in the Feishu app's permission settings, then explicitly reauthorize:

```sh
node dist/cli.js login --app-id cli_YOUR_APP_ID --document-images
```

Preserve your existing profile and `--offline` choice. Confidential-client authentication is automatic. `--document-images` adds only the media-upload scope; it does not enable writes. Default login scopes are unchanged. Existing broader grants accepted by Feishu are recognized, but no scope or identity fallback is performed. Same-account reauthorization is picked up by running MCP sessions; reconnect after rebuilding to discover updated tools. Keep `BETTER_FEISHU_MCP_ENABLE_WRITES=1` for direct writes. Terminal approval is required only if you choose the legacy prepare/commit tools.

**Validation:** image creation/append, multipart requests, changed-file refusal, local approval, missing scopes and partial failures are tested with synthetic APIs and actual local screenshot headers. On 2026-11-05, a human-approved guide with 35 content blocks and five PNG images was created through the live MCP. Readback verified all five image tokens, dimensions and captions at revision 7. Visual rendering, live append and failure recovery remain unverified. API references: [upload media](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all), [upload-point binding](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/introduction), [image-block update](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/patch).

Legacy drafts are claimed before the network request and never automatically replayed. Neither workflow automatically retries writes. A failed content insertion returns the created document ID for recovery. An ambiguous create timeout may require manually checking recent documents. There is no automatic rollback or permanent deletion.

## State and privacy

- Credentials: OS keychain service `better-feishu-mcp.feishu.cn`, one entry per named profile. No file fallback; Linux explicitly requires Secret Service rather than silently selecting kernel storage.
- Pending write drafts: private `0700` profile directory under `~/.local/state/better-feishu-mcp`, `0600` files. These contain proposed content until consumed or expired drafts are pruned on a later preparation. Receipts contain operation metadata/results, not token values; crash-claimed drafts may remain for manual recovery. There is no background cleanup daemon.
- Local test evidence: ignored `.runtime/`; no tokens or private message/document bodies in reports.
- `BETTER_FEISHU_MCP_STATE_DIR` changes state location at startup only. No tool can supply a credential/state path or authenticated host.
- Retrieved content reaches your configured MCP client/model. Local hosting is not offline operation or a privacy guarantee.

The server is **not an OS sandbox**. An agent with unrestricted shell/keychain access has powers beyond these MCP safeguards; terminal/TTY checks are not cryptographic proof of human presence. See [SECURITY.md](SECURITY.md).

## Permissions

User scopes: `search:message`, `im:chat:read`, `im:message:readonly`, `im:message.group_msg:get_as_user`, `im:message.p2p_msg:get_as_user`, `docx:document:readonly`, `docx:document:create`, `docx:document:write_only`, `space:document:delete`, `sheets:spreadsheet:readonly`.

No `search:docs:read`, `im:message.send_as_user` or tenant-token access is requested. On the tested app, the original nine scopes were Added without another release; the new Sheets scope's approval requirements remain unverified. Scope eligibility can differ elsewhere.

## Validation and release status

- Automated tests exercise schema validation, credential rotation/races, scope gates, HTTP limits, approval integrity/replay/expiry, revision conflicts and real SDK stdio calls.
- `npm run test:stdio` runs a credential-free real-client smoke test.
- `npm run test:stdio -- --live` reads only the known temporary group fixture through a real client.
- `npm run test:stdio -- --live --live-crud` additionally authorizes the **trusted test runner** to approve and mutate only its newly created disposable document, then delete it. It verifies unapproved writes are rejected first; it does not simulate a human at the CLI. Never use unreviewed test scripts with credentials.
- [Live evidence and limits](docs/VALIDATION.md), [plan](docs/PLAN.md), [original research](docs/reports/Feishu%20MCP%20feasibility%20and%20architecture.md).

The package remains `private: true` / `UNLICENSED` pending the user's license decision. No public release, remote, client configuration edit, external deployment or security audit is implied by local tests passing.
