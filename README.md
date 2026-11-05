# better-feishu-mcp

A local TypeScript MCP that uses **your Feishu identity** to read messages and create/read/update/delete modern Feishu documents. Built from scratch against Feishu APIs—not a wrapper around another Feishu MCP or CLI.

**Local alpha.** Real stdio-client message reads and a disposable-document CRUD cycle have passed on the tested Feishu China account. No remote hosting or public package/repository exists. License selection is pending; the package is private.

- **No bot membership in chats.** App/bot registration may be required; adding the bot to a chat is not part of this implementation.
- **No tenant-token fallback.** Unsupported or missing user access fails explicitly.
- **No message sending or document search.** Those scopes required approval and are excluded.
- **Writes off by default.** Enabling them still requires approval of each exact operation outside MCP.

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

Default login uses S256 PKCE plus the app secret. The tested account rejected PKCE with code `20049`; its cause remains unresolved. The user-approved alternative succeeded:

```sh
BETTER_FEISHU_MCP_BROWSER=Zen node dist/cli.js login \
  --app-id cli_YOUR_APP_ID --auth-mode confidential
```

`--auth-mode confidential` is an **explicit non-PKCE choice**, not automatic fallback. Both modes use state, an exact loopback callback, user consent and confidential-client credentials. On success, the app secret, user tokens and identity binding are stored in the OS keychain. A profile cannot change app/user/tenant without `--replace` or a separate profile.

```sh
node dist/cli.js status
node dist/cli.js doctor --probe-keychain
node dist/cli.js logout
```

No refresh token is requested by default: re-login after expiry. `login --offline` explicitly requests `offline_access` if your app is allowed that scope. Rotation is serialized and marked uncertain before the one-use refresh token is sent; ambiguous failures require re-login, never a blind retry. Live refresh is not yet verified. Logout removes local credentials, not the provider-side grant—revoke that separately in Feishu's App authorization management.

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

Client configuration formats differ; the important fields are command, args and environment. This project does **not** change your global client configuration. Restart the MCP process after a new login. Protocol-only stdout; diagnostics on stderr. Both modern and legacy stdio openings are served by the SDK adapter.

## Tools

| Read tools | Purpose |
|---|---|
| `auth_status` | Token-free identity, expiry, scopes and write-policy diagnostics |
| `chats_list` | Bounded joined-group listing; not a DM directory |
| `messages_search` | Visible-message snippets/metadata, optionally filtered by chat |
| `messages_history` | Recent group or p2p history with explicit chat ID and visibility |
| `threads_history` | Replies for an explicit thread ID |
| `messages_get` | Retrieve an individual message |
| `documents_get` | Modern Docx metadata and revision |
| `documents_read` | Plain text capped at 100000 characters |
| `documents_blocks` | Structured blocks with opaque, revision-bound cursors |

Group history/get/search have passed live tests in the sole-user fixture chat with bot absence verified in the Feishu UI. P2p, thread and normal multi-person group cases remain unverified; scope support does not override tenant or resource restrictions.

### Document writes

Set `BETTER_FEISHU_MCP_ENABLE_WRITES=1` **in the MCP server environment** to expose:

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

No MCP tool can approve a write. Approval signatures are bound to payload, target, expiry and login identity using a key held in the OS keychain. Relogin invalidates prior drafts. A model-supplied `confirm: true` is not accepted.

Content creation supports paragraphs, headings, bullets, ordered lists, quotes and code blocks. Basic paragraph create/read/replace/delete is live-tested; other block types are contract/unit-tested only. No lossless Markdown round trip, table/media editing, Wiki lifecycle or legacy Docs claim. Replacing a block's text replaces its rich-text elements; unrelated blocks are left alone. Revision preflight is **best-effort**, not an atomic multi-user transaction guarantee.

Writes are claimed before the network request and never automatically replayed. A failed content insertion returns the created document ID for recovery. An ambiguous create timeout may require manually checking recent documents. There is no automatic rollback or permanent deletion.

## State and privacy

- Credentials: OS keychain service `better-feishu-mcp.feishu.cn`, one entry per named profile. No file fallback; Linux explicitly requires Secret Service rather than silently selecting kernel storage.
- Pending write drafts: private `0700` profile directory under `~/.local/state/better-feishu-mcp`, `0600` files. These contain proposed content until consumed or expired drafts are pruned on a later preparation. Receipts contain operation metadata/results, not token values; crash-claimed drafts may remain for manual recovery. There is no background cleanup daemon.
- Local test evidence: ignored `.runtime/`; no tokens or private message/document bodies in reports.
- `BETTER_FEISHU_MCP_STATE_DIR` changes state location at startup only. No tool can supply a credential/state path or authenticated host.
- Retrieved content reaches your configured MCP client/model. Local hosting is not offline operation or a privacy guarantee.

The server is **not an OS sandbox**. An agent with unrestricted shell/keychain access has powers beyond these MCP safeguards; terminal/TTY checks are not cryptographic proof of human presence. See [SECURITY.md](SECURITY.md).

## Permissions

User scopes: `search:message`, `im:chat:read`, `im:message:readonly`, `im:message.group_msg:get_as_user`, `im:message.p2p_msg:get_as_user`, `docx:document:readonly`, `docx:document:create`, `docx:document:write_only`, `space:document:delete`.

No `search:docs:read`, `im:message.send_as_user` or tenant-token access is requested. On the tested app, the nine retained scopes were Added without another release; scope eligibility can differ elsewhere.

## Validation and release status

- Automated tests exercise schema validation, credential rotation/races, scope gates, HTTP limits, approval integrity/replay/expiry, revision conflicts and real SDK stdio calls.
- `npm run test:stdio` runs a credential-free real-client smoke test.
- `npm run test:stdio -- --live` reads only the known temporary group fixture through a real client.
- `npm run test:stdio -- --live --live-crud` additionally authorizes the **trusted test runner** to approve and mutate only its newly created disposable document, then delete it. It verifies unapproved writes are rejected first; it does not simulate a human at the CLI. Never use unreviewed test scripts with credentials.
- [Live evidence and limits](docs/VALIDATION.md), [plan](docs/PLAN.md), [original research](docs/reports/Feishu%20MCP%20feasibility%20and%20architecture.md).

The package remains `private: true` / `UNLICENSED` pending the user's license decision. No public release, remote, client configuration edit, external deployment or security audit is implied by local tests passing.
