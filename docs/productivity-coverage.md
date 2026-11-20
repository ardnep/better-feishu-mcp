# Productivity coverage — 0.2.0

Evidence date: 2026-11-20. This is scoped API support, not arbitrary format round-tripping or a guarantee of tenant/resource access. The 62 reviewed extra grants remain unchanged. Normal tools reuse the existing user login; mutations and local downloads require the existing write opt-in, not local per-document approvals.

This release adds **88 tools** (31 read tools and 57 mutations/local-download tools), for **106 normal tools** when writes are enabled, or 45 when disabled. Legacy approval tools remain hidden by default. Automated scope coverage asserts that every reviewed grant is mapped to an implemented surface or the explicit board-update blocker, and excluded capabilities are not introduced.

## Capability and scope manifest

| Reviewed scope family | Implemented surface | Live evidence |
|---|---|---|
| `base:app:create`, `bitable:app:readonly` | Base create/metadata | Passed |
| `base:table:{create,read,update,delete}` | Table CRUD | Passed |
| `base:field:{create,read,update,delete}` | Field CRUD with bounded native properties | Passed (text field) |
| `base:record:{create,read,retrieve,update,delete}`, `base:view:read` | Record CRUD/search, view listing | Passed (text record) |
| `sheets:spreadsheet:{create,read,write_only}`, `sheets:spreadsheet.meta:{read,write_only}` | Create/read/write/rename; tab create/update/delete | Passed; native `=1+1` formula result read back as `2`. Narrow granted pack works here despite broader legacy documentation. Meta-read-only tokens not isolated in live tests. |
| `drive:drive.metadata:readonly` | Root and explicit-file metadata | Passed |
| `drive:file:{upload,download}` | Canonical local file transfers, at most 5 MB | Passed (text upload/download) |
| `docs:document:copy`, `space:document:{move,shortcut}`, `space:folder:create` | Copy/move/shortcut/folder lifecycle | Passed on newly created files/folders |
| `docs:document:{import,export}` | Start/status/download async jobs | Passed: TXT → Docx with text readback; Docx → DOCX with nonempty download. Other supported conversions not live-tested. |
| `docs:document.comment:{create,read,update,delete}` | Whole-document comments, resolve/reopen, reply/create/update/delete | Create/list/resolve passed. Reply creation blocked by provider content review `1069302`; reply update/delete not live-tested. Delete applies to replies, not whole threads. |
| `docs:document.media:download` | Explicit media download to new local path | Fixture-tested only |
| `wiki:space:{retrieve,read,write_only}`, `wiki:node:{retrieve,create,update,move,copy}` | Space list/read/private creation; node list/create/rename/move/copy | Space listing passed. Other operations fixture-tested only; no existing Wiki resources mutated. No Wiki-space/node delete tool. |
| `board:whiteboard:node:delete` | Explicit node batch delete | Passed; empty-board readback verified |
| `board:whiteboard:node:update` | **Not exposed** | Blocked: no verified documented existing-node update endpoint found. Existing board create/read remains available. No invented endpoint. |
| `calendar:calendar` | Calendar/event CRUD, anchored pagination, availability | Passed on private disposable calendar/events and current-user availability. No attendee invitations or notification tests. |
| `task:task:read`, `task:tasklist:read` | Task/tasklist list/get | List endpoints passed; get and other resources fixture-tested only |
| `task:comment:{read,write}`, `task:section:{read,write}`, `task:custom_field:{read,write}` | Comment CRUD, tasklist section CRUD, typed custom-field create/read/rename | Fixture-tested only; no existing tasks/tasklists mutated. Custom-field deletion is not exposed. |
| `task:attachment:{read,write}` | Attachment list/upload/delete | Fixture-tested only; upload limited to 5 MB |
| `im:chat.members:read`, `im:message`, `im:message.pins:{read,write_only}`, `im:message.reactions:{read,write_only}` | Member/reaction/pin reads and reaction/pin mutations | New tools fixture-tested only; existing message reads passed real stdio live tests. No existing chats modified for validation. |

Every reviewed extra scope is represented above. A scope family does not imply every native operation or every content subtype is supported. Native Base properties/task custom-field settings remain provider-validated bounded JSON. Section operations target tasklists; custom-field updates currently rename definitions, not set task values. Calendar event writes omit attendees and disable notifications. Writes can still fail due to role restrictions, moderation, unsupported field types or provider limits.

## Safety and automated verification

- Strict, fixed-endpoint tool schemas; no caller-selected API origin, HTTP method or credentials.
- Scope checks before network/local transfer effects, user-only identity and unchanged refresh behavior.
- Per-target mutation locks; POST/PUT/PATCH/DELETE mutations make one network attempt only. Read-only search POSTs explicitly opt into the read retry policy.
- Input bound 100 KB, provider JSON bound 2 MB, MCP output bound 512 KB. Lists use opaque identity/tool/filter/limit-bound cursors. Calendar lists use 50 items per upstream page; event listing uses `anchor_time` rather than incompatible paginated time-window queries.
- Local uploads reject symlinks/nonregular files and enforce 5 MB even if a file grows during reading. Downloads create a new file exclusively with mode 0600; no overwrites or authenticated arbitrary-URL fetches. Failed downloads retain a possibly empty/partial target, reported explicitly.
- Sheets writes require exact rectangular dimensions and explicit formula opt-in; no automatic mentions, protection or sharing changes.
- Fixtures cover each new non-transfer tool's schema, scope gate, fixed-origin request and mutation write gate; transfer gates, filesystem bounds, no overwrite, cursor binding, serialization, formula encoding and non-retry behavior have dedicated tests. Real MCP stdio tests verify new tool discovery/annotations with writes on/off.

## Reproduce and interpret results

```sh
npm test
npm run test:auth-harness
npm run test:stdio
npm run test:stdio -- --live --live-crud
node scripts/productivity-live.mjs --live-disposable
```

The last command explicitly authorizes disposable-resource writes and bounded local test artifacts under the configured state directory. It records `.runtime/productivity-live.json`; the latest run reported successful cleanup requests for every created top-level document, Base, Sheet, folder and calendar. Folder cleanup moves descendants to the recycle bin; it is not permanent erasure or an asynchronous deletion-completion guarantee. No retained user test document or pre-existing team resource was mutated. The live runner **exits nonzero** for the provider's reply-review rejection; this is not an all-green live suite. Other unlisted operations remain unverified rather than assumed successful.

Reconnect/restart the MCP client after rebuilding to discover the expanded tools. The existing authenticated user grant remains reusable; no new OAuth consent or permissions were added for this implementation.
