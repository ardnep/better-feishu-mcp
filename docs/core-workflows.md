# Core workflow expansion — 2026-11-20

This extends the existing v0.2.0 toolset without moving its release tag. It is
not a claim that every audited core requirement is fully supported.

## Permissions and consent

The Feishu app version was observed **Approved / Released**. The first OAuth
attempt failed with 20027: the console had selected `task:task:writeonly` and
`docs:permission.setting:readonly`, not the intended full task `write` and
permission-settings `read` scopes. The corrective selections were cancelled
when the user deferred further app approval. No new approval was submitted.

Same-account OAuth then succeeded for the actual 17 additions listed in
`permission-packs/core-user-scopes.json`. Token-free CLI status confirmed all
17, preservation of prior grants, and an active renewable user login. Default
login scopes and credential storage behavior were not changed.

## Implemented and live-tested

| Workflow | New surface | Evidence / limits |
|---|---|---|
| Own messages | `messages_send`, `messages_reply`, `messages_recall` | Text send/reply and native file/image send passed in the predesignated sole-user fixture. Membership was checked before sending. Sender readback matched the authorized user. Recall succeeded for all four initial test messages; a separate send/recall/readback confirmed `deleted: true`. |
| Native attachments | `messages_upload_file/image` | Native IM keys uploaded and sent successfully. These are not Drive tokens. Local uploads retain the 5 MB regular-file guard; message download/image-delivery caps remain removed. |
| Discovery | `people_get`, `chats_search/get`, `documents_search`, `drive_files_list` | Own identity lookup, fixture chat discovery/details, filtered document search and explicit root-folder browsing passed live. Search uses body pagination and opaque identity/filter-bound cursors. People lookup is explicit-ID only, not global fuzzy discovery. |
| Targeted sharing | `sharing_members_list/add/update/delete`, `sharing_settings_get` | Collaborator listing passed on a disposable document. Recipient-changing tools have fixture coverage only: no third-party recipient was authorized for live sharing tests. Settings reads remain blocked by their documented missing scope. No public-setting writes or owner transfer. |
| Scheduling | `calendar_attendees_list/add/delete`, `calendar_events_reply`; explicit update/delete notification choice | Add/list/remove self on a disposable event passed. RSVP on an organizing shared calendar returned 191004 (invalid calendar type); a fresh disposable invitation read and RSVP on the current user's primary calendar both passed. Both test calendars were deleted. |
| Tasks | `tasks_create/update/delete`, member and task-list association tools | Narrow-scope create, summary/deadline change, completion, readback and reopening passed. Assignment, list association and deletion stay full-scope-gated and were not attempted. One labelled test task was left completed because deletion needs the deferred full scope. |
| Task lists | `tasklists_create/update/delete/tasks/members_add/members_remove` | Create, rename, task listing and delete passed. Named-member changes remain fixture-only; no owner-transfer tool is exposed. |
| Base | `base_update`, `base_views_create/update/delete` | Rename Base and create/rename/hide-fields/delete view passed. Disposable Base deleted. Advanced permission settings are not modified. |
| Workplace attachments | XLSX/PPTX through `messages_read_attachment` | Worker tests cover shared/inline XLSX strings, formula text/cached values, PPTX text, DTD rejection and unsupported legacy XLS. Actual user Office attachments were not used as live fixtures. |
| Group coordination | `chats_update`, `chats_members_add/delete` | Strict fixed-route fixtures cover metadata and explicitly named human users only. No live mutations: no newly created disposable group is available under the user-only architecture. Existing test chat was not renamed or given new members. |

Existing Docs, Sheets, Wiki, comments and board functionality is preserved.
These tools do not promise arbitrary document-layout editing or lossless
content-format round-tripping.

## Deliberately unresolved

- Human-sent message editing: checked edit API is tenant-only; no fallback.
- User-only group creation: checked creation API conflicts with no-bot-membership.
- Global fuzzy people discovery: exact user-token contract remains unverified.
- Full task assignment/list placement/deletion: `task:task:write` deferred.
- Public-permission-settings read: documented `docs:permission.setting:read`
  deferred; `readonly` is not assumed equivalent.
- Existing board-node update and earlier content-review restrictions remain as
  recorded in `productivity-coverage.md`.

## Validation and retained fixtures

`npm test`, `npm run test:auth-harness` and `npm run test:stdio` cover schemas,
scope/write gates, ownership refusal, fixed-origin routes, body pagination,
native multipart fields and non-replay behavior. `scripts/core-live.mjs
--live-disposable` exercises disposable resources and the designated sole-user
chat. It never chooses an arbitrary colleague or team resource for mutation.

Final automated result: **253 tests / 14 files passed**, plus **5 auth-harness
checks** and the credential-free real-stdio smoke. The expansion adds **39
tools**, for **145 normal tools** with writes enabled.

The local OpenCode MCP connection was disconnected/reconnected after the build;
the refreshed catalog reported 145 tools and `auth_status` confirmed the existing
user identity, active renewable consent and enabled writes. At the user's later
explicit request, a single test DM was sent to Luke after verifying his identity
through group membership and `people_get`. Readback through the actual reloaded
MCP confirmed the message content and authorized-user sender. This confirms API
delivery/readback, not that Luke has read or replied to it. The test DM was left
in place as requested.

The initial live run had one RSVP failure described above, corrected by the
separate primary-calendar test; do not describe that initial run as all green.
All nine registered cleanup actions succeeded: four recalls, task completion,
task-list deletion, calendar deletion, Base deletion and document recycle-bin
deletion. The second RSVP fixture and recall-readback message were also cleaned
up. Retained:

- Completed task `6b76fca5-47f7-4bd8-ba32-52ba73657434`, labelled
  `mcp-core-disposable-*`, for optional manual deletion.
- One disposable native IM file and image upload: no verified upload-delete API.
- Small local upload fixture files in the private application state directory.

## Office text limitations

OOXML extraction runs in the existing 15-second / 128 MB worker, using ZIP
guards (200 entries, 5 MB per expanded entry, 20 MB declared aggregate). It
does not follow external relationships, evaluate formulas, run macros or write
extracted files. XML DTD/entity declarations are rejected.

XLSX emits cell addresses and shared/inline strings or raw cached values;
dates remain serial values. Worksheet and slide parts use numeric filename
order, **not guaranteed workbook/presentation display order**. Formatting,
hidden-state semantics, charts, images, animations, speaker notes and embedded
objects are not reconstructed. Legacy XLS/PPT, encrypted files, OCR and
audio/video transcription are unsupported. Text remains capped at 100000 chars.
