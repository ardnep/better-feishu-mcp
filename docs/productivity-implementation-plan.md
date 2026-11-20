# Approved productivity implementation

Scope: the existing 77 user grants, including the 62 explicit extras in `permission-packs/productivity-user-scopes.json`. No new app grants, tenant tokens, employee message sending, document search, task creation/completion or sharing administration.

## Delivery checklist

- [x] Shared bounded, fixed-endpoint tool registration, write gates, per-target locks and scoped pagination
- [x] Sheets creation, values/formulas, tabs and metadata
- [x] Drive metadata, file/folder upload/download/copy/move/shortcut and import/export jobs
- [x] Document comments/replies and document-media downloads (reply creation provider-blocked)
- [x] Wiki spaces and page lifecycle (writes fixture-tested only)
- [x] Base apps/tables/fields/records and view reads
- [x] Board node deletion; update blocked without a verified public API
- [x] Chat member/reaction/pin tools (fixture-tested only)
- [x] Calendar discovery, events and availability
- [x] Task/tasklist reads, sections, custom fields, comments and attachments (ancillary writes fixture-tested only)
- [x] Scope coverage manifest, tests and limitations
- [x] Disposable-resource live validation, cleanup requests, rebuild and new stdio-process validation

Delivery: version 0.2.0, direct `main` publication and GitHub release/tag requested by the user. Reconnect existing MCP clients after the build; token renewal does not hot-reload their tool catalogs. See `productivity-coverage.md` for explicit blocked/unverified workflows.

## Invariants

Use only the existing authorized user. Keep reads byte-bounded and paginated, output untrusted, schemas strict and endpoint paths fixed. Writes require the existing server opt-in; they do not introduce per-document approvals. Retain resource ACLs and scope gates. Serialize mutations to a resource; do not retry an uncertain write. Expose asynchronous import/export/upload outcomes honestly. File transfers use explicit canonical paths, bounded local reads and exclusive download creation; no remote-URL upload or automatic overwrites. Never mutate existing team resources merely to test a tool.

Each feature must be marked implemented versus live-validated versus blocked. Scope approval does not establish endpoint eligibility. Especially check legacy Sheets range writes, which document broader grants than the currently approved narrow scope.
