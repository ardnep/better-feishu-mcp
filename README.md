# better-feishu-mcp

A local TypeScript MCP server for Feishu, using **your user identity** rather than a bot in your chats.

**Local alpha · 0.2.0.** Public source under [AGPL-3.0-or-later](LICENSE). Feishu China only; no public npm package or remote hosting.

## What it does

| Area | Capabilities |
|---|---|
| Messages | Search and read messages, threads and attachments; send/reply, recall your own messages, manage reactions and pins |
| Documents | Read, create, edit and recycle Docs; add inline images and editable Mermaid flowchart boards |
| Sheets | Read and write ranges, manage tabs, create and rename spreadsheets |
| Drive & Wiki | Browse files, manage folders and Wiki nodes, upload/download, import/export |
| Base | Manage tables, fields, records and views |
| Calendars & tasks | Manage calendars, events, attendees, tasks and task lists |
| Collaboration | Comments, named-user sharing and group-member coordination |

Availability depends on your app's user scopes, resource access and tenant policy. See [workflow coverage and limits](docs/core-workflows.md) for details.

## Setup

Requires **Node.js 24**, a Feishu China custom app and an OS keychain. macOS is live-tested; Linux Secret Service and Windows credential support are implemented but not live-validated.

```sh
npm ci --ignore-scripts
npm run build
```

### 1. Log in

Register this exact OAuth redirect in your Feishu app's Security Settings:

```text
http://127.0.0.1:52741/callback
```

Enable the required user scopes, including `offline_access` for the default renewable login, then run:

```sh
node dist/cli.js login --app-id cli_YOUR_APP_ID
```

Enter the App Secret in the local browser form—not in command-line arguments, source or chat. Credentials are stored in the OS keychain, with no plaintext fallback.

Optional login flags:

| Flag | Purpose |
|---|---|
| `--document-images` | Request document media-upload permission |
| `--document-boards` | Request board creation/read permissions |
| `--scope SCOPE` | Request an additional user scope; repeat as needed |
| `--temporary` | Log in without token renewal |

The form shows the requested scopes before consent. App approval and user consent are separate requirements; neither bypasses resource access controls. Preserve optional flags and extra scopes when reauthorizing.

### 2. Connect your MCP client

Use your client's local stdio configuration, replacing the path below:

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

Use an absolute Node executable path if your client cannot find Node 24. Reconnect after rebuilding or changing the server environment. Same-account re-login is picked up automatically by processes sharing the profile and state directory; switching identity requires a restart.

### 3. Enable writes when needed

Set `BETTER_FEISHU_MCP_ENABLE_WRITES=1` in the server environment and reconnect. This enables mutations **and local downloads**, subject to granted scopes and resource access.

Direct writes use the existing login without per-edit terminal approval. Use your MCP client's tool permissions for interactive review. Legacy prepare/approve/commit tools stay hidden unless `BETTER_FEISHU_MCP_ENABLE_LEGACY_APPROVALS=1` is also set.

## Safety and limits

- No bot chat membership or tenant-token fallback. Missing user access fails explicitly.
- Read the current document revision before updating or deleting. Revision checks are best-effort, not atomic transactions.
- Writes are not automatically retried or rolled back. Inspect the resource before retrying an uncertain operation.
- Sending/replying requires explicit recipients/content and a stable delivery UUID. Recall affects the conversation, not just your view.
- Local file uploads/downloads generally have a 5 MB limit and require canonical absolute paths; downloads never overwrite existing files. Message attachment downloads and inline images have **no application byte-size cap**.
- Human-message editing, user-only group creation, public-sharing changes and ownership transfer are unsupported.
- Retrieved content is untrusted and reaches your configured client/model. Local hosting is not offline operation or an OS sandbox.

Read [SECURITY.md](SECURITY.md) before enabling writes.

## Diagnostics and development

```sh
node dist/cli.js status
node dist/cli.js doctor --probe-keychain
node dist/cli.js logout

npm test
npm run test:stdio
```

The MCP `auth_status` tool reports identity, scopes, expiry and write policy without exposing credentials. Logout removes local credentials; revoke the provider-side grant separately in Feishu.

## Further reading

- [Setup and status overview](docs/review/setup.html)
- [Core workflows, permissions and live limits](docs/core-workflows.md)
- [Productivity coverage](docs/productivity-coverage.md)
- [Live validation evidence](docs/VALIDATION.md)
- [Optional permission packs](docs/permission-packs/) — never loaded automatically

Live tests cover selected workflows on one Feishu China account, not every tool or tenant. Local test results do not imply a security audit or production readiness.
