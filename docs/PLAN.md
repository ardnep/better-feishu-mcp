# better-feishu-mcp implementation decision and delivery plan

> **Live validation update, 2026-11-04:** User-token group discovery, scoped message search, history/get in a newly created sole-user/no-bot group, and modern Docs CRUD passed for the selected Feishu China app/user/tenant. Document search was removed because it required approval; direct document IDs/links remain the core route. User-approved confidential-client OAuth without PKCE worked after S256 exchanges failed with `20049`; production OAuth mode still needs an explicit decision. See [validation evidence](VALIDATION.md). These are API-harness results, not a completed MCP or universal compatibility claim.

Status: **design baseline with local-alpha implementation delivered, 2026-11-04**. The user subsequently authorized implementation and fixture-only live testing. See [the implementation record](IMPLEMENTATION.md), [current setup](review/setup.html) and [README](../README.md) for actual tool names, commands and validation. The architecture/phases below preserve the original plan, not a claim that all future work is complete. Public release, remote setup and deployment remain out of scope. Read the [cited report](reports/Feishu%20MCP%20feasibility%20and%20architecture.md) for original evidence and conflicts.

## 1. Non-negotiable contract

- Act only as the consenting Feishu user using `user_access_token`. Never choose `auto`, request a tenant token as fallback, or silently switch account/app/tenant.
- Creating an app or enabling bot capability is acceptable after authorization. **Never add the bot to any group chat**, including tests and troubleshooting. Do not expose bot-join/invite tools.
- Prioritize useful reads, which the user reports having done before. Sending is an independent optional feature; its failure does not invalidate reads.
- Feishu Docs CRUD is a core delivery requirement alongside message reads: create, read, update and delete documents as the user. Read-only is an initial milestone, not the completed product. Initially target modern Feishu Docs (Docx); legacy Docs, Sheets, Base and Wiki lifecycle operations are separate scope decisions.
- Feishu China first: fixed API origin `https://open.feishu.cn`, token origin `https://accounts.feishu.cn`. Lark is an explicit unsupported profile until independently audited; do not substitute hostnames mechanically.
- Default to curated, bounded read tools. No arbitrary endpoint, shell, cookie reuse, private API, event subscription or background bulk indexing.
- No guarantee of no-admin setup, scope availability, free-plan coverage, no-bot endpoint success or universal tenant compatibility.
- “Local-only repository” means no remote/publication/hosting. A future local MCP would still call Feishu over HTTPS and disclose selected results to its configured client/model; explain that data flow before login.

## 2. Decision: build from scratch on the Feishu APIs

The user has selected an independent TypeScript implementation using documented Feishu HTTP APIs directly. Do not fork, wrap, invoke, or depend on the existing Feishu/Lark MCP or CLI. Evaluating those tools is not a prerequisite or a delivery phase.

Build and own the Feishu API adapters, OAuth lifecycle, token custody integration, capability policy, curated MCP tools and normalized errors. Use direct HTTP requests for upstream operations; no CLI subprocess or existing Feishu MCP intermediary. Standard infrastructure libraries remain appropriate: the official MCP TypeScript SDK, schema validation, testing and an audited OS-keychain binding. “From scratch” does not mean inventing cryptography or reimplementing the MCP protocol.

Existing-product research remains background only, not an implementation recommendation. Validate behavior against official Feishu endpoint contracts and authorized live API tests. Record the direct-API architecture, dependency choices and tested client/runtime versions before implementation.

## 3. Proposed architecture

Target a supported Node LTS, TypeScript and local stdio. Current upstream README identifies stable SDK v2 and npm returned `@modelcontextprotocol/server` 2.4.0 during synthesis; **no version has been installed or tested**. Recheck primary sources and pin exact server/client/schema versions plus lockfile only during approved implementation. If freshness or target-client support is uncertain, leave version selection pending. Do not mix split v2 imports with v1 examples. [SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Registry](https://registry.npmjs.org/@modelcontextprotocol/server/latest)

Proposed flow: MCP client → stdio adapter → capability/policy gate → domain service → user-only API adapter → Feishu. Auth/token custody is a separate service used by the API adapter; tool arguments cannot select credential paths or authenticated hosts.

| Boundary | Responsibility |
|---|---|
| `core/` | Validated domain types, normalized errors, deadlines, cancellation; transport-independent |
| `feishu/` | Fixed region endpoints, explicit U-only adapters, bounded pagination, response normalization, per-endpoint quotas/retries; reject authenticated cross-host redirects |
| `auth/` | State/S256 OAuth, actual scope inspection, expiry, serialized refresh, identity checks |
| `credentials/` | Keychain interface and platform implementation, atomic rotation; profile key includes region/app/tenant/user; no plaintext fallback |
| `policy/` | Immutable startup capability manifest and invocation authorization; user policy can only be narrowed by workspace policy |
| `services/`, `tools/` | Curated workflows, small schemas, capped results, source IDs/links and next-page cursors |
| `transports/stdio` | Protocol-only stdout; diagnostics on stderr; lifecycle/cancellation |
| `cli/`, `observability/` | Proposed `login`, `status`, `logout`, `doctor`, `serve --stdio`; redacted content-free diagnostics; no token display |
| `transports/http` (deferred) | Separate authenticated hosted/local HTTP adapter only if later justified |

Each manifest entry must record endpoint/method, region, U-only support, exact AND/OR scope expression, resource constraints, read/write/export/destructive class, allowlists, rate/page/byte bounds, idempotency/retry rules, primary source, date and validation status. Capability = enabled tool ∩ identity support ∩ actual grants ∩ resource rights ∩ local policy ∩ operation approval. Check at discovery and invocation. Tool annotations are hints, not authorization.

Do not invent HTTP session/initialization machinery from old tutorials: current specification behavior and target-client compatibility must be tested. Local HTTP is an option, not a required intermediate phase. Hosted Streamable HTTP would require separate MCP OAuth/audience-bound tokens, upstream grant custody, consent, HTTPS/Origin checks, isolation and retention review. Feishu tokens are not MCP bearer tokens. Public Figma remote and desktop-local HTTP offerings illustrate deployment variety; they do not establish equivalence to this environment's injected Figma server. [Transport](https://modelcontextprotocol.io/specification/latest/basic/transports), [Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [Figma remote](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/), [Figma desktop](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)

## 4. Incremental user-identity scope bundles

All bundles are optional and requested only for a needed next workflow. These are documentary proposals; check correct **user-identity** scope eligibility/effectiveness in the target console. OR means choose an eligible least-privilege alternative, not enable all. `offline_access` is an independent persistent-session opt-in.

| Bundle | Proposed tools | Exact starting scope expression / prerequisite |
|---|---|---|
| IM search only | `messages.search` | `search:message`; snippets/IDs only; no automatic hydration |
| Group discovery | `chats.list` | `im:chat:read` preferred; alternatives in report; app bot capability enabled, never joined to group |
| Group bodies/history | `messages.get`, `messages.history`, `threads.history` | (`im:message:readonly` OR `im:message`) AND `im:message.group_msg:get_as_user` |
| P2p bodies/history | Same tools with p2p enforcement | (`im:message:readonly` OR `im:message`) AND `im:message.p2p_msg:get_as_user`; IDs from explicit input/search, not promised exhaustive DM list |
| Members, optional | `chats.members` | `im:chat.members:read` preferred; excludes bots in returned list |
| Docx text | `documents.read_text` | `docx:document:readonly` |
| Wiki resolution | `wiki.resolve` | `wiki:node:read` OR `wiki:wiki:readonly`; downstream content scope separately |
| Document discovery | `documents.search`, `drive.list_folder` | Search: `search:docs:read`; folder: `space:document:retrieve` OR `drive:drive:readonly` |
| Structured data | `sheets.read_range`, `base.search_records` | Sheets: `sheets:spreadsheet:readonly`; Base: `base:record:retrieve` OR `bitable:app:readonly`; advanced roles still apply |
| Personal work | `tasks.list_assigned`, `calendar.list_events` | Tasks: `task:task:read`; events: `calendar:calendar.event:read` OR `calendar:calendar:readonly` |
| Identity lookup, optional | `contacts.get` | `contact:contact.base:readonly`, plus field scopes such as `contact:user.base:readonly`; avoid employee-ID/contact-wide enrichment by default |
| Export-sensitive opt-in | `minutes.export_transcript` | `minutes:minutes.transcript:export` plus actual export right |
| Mail-sensitive opt-in | `mail.get_message` | `mail:user_mailbox.message:readonly` plus exact `mail:user_mailbox.message.body:read`, `mail:user_mailbox.message.subject:read`, `mail:user_mailbox.message.address:read` only as required; custom-app constraint |
| User send/reply, disabled | `messages.prepare_send`, `messages.commit_send`, `messages.prepare_reply`, `messages.commit_reply` | **`im:message` AND `im:message.send_as_user`**, tenant eligibility, live no-bot test and trusted approval channel |
| Reactions, disabled | `messages.prepare_reaction`, `messages.commit_reaction` | `im:message.reactions:write_only` OR `im:message`; independently tested/approved |
| Recall, deferred | Separate prepare/commit pair if justified | Verify user-eligible scopes, own-message/role eligibility and recall windows; not local-view delete |

Exact endpoint evidence and additional alternative scopes are in the [report tables](reports/Feishu%20MCP%20feasibility%20and%20architecture.md). Message editing, IM upload/download, Base/Sheet writes, calendar/task mutation and sharing stay deferred pending endpoint-specific audits. Docs create/update/delete are required core work, but remain disabled until their own endpoint audits and tests pass. Public IM attachment/edit references currently document tenant-only routes; do not resolve that by using bot tokens. Calendar bot capability does not authorize or require group membership.

### Core Docs CRUD track

Build directly against documented Docx and Drive APIs under user identity. The earlier research verified representative document reads, not the complete mutation surface: exact create/update/delete endpoints, user-token support, minimal scopes and trash/recovery semantics must be audited before implementation. Do not present candidate scope names as verified grants or substitute tenant tokens when blocked.

| Operation | Proposed workflow | Acceptance gate |
|---|---|---|
| Create | `documents.prepare_create` / `documents.commit_create`: title, explicit parent folder and supported content | Create in a user-selected writable folder; return document ID, URL and content summary; handle partial creation without duplicate documents |
| Read | `documents.get`, `documents.read_text`, `documents.list_blocks`: metadata, readable text and paginated structured blocks | Read owned/shared documents accurately; preserve block IDs and available revision information for later targeted edits; expose unsupported content explicitly |
| Update | `documents.prepare_update` / `documents.commit_update`: targeted append, insertion, replacement and block removal | Show exact target and change preview; preserve untouched blocks/formatting; detect stale revisions or concurrent edits using supported provider mechanisms, otherwise fail safely on uncertainty |
| Delete | `documents.prepare_delete` / `documents.commit_delete`: exact document identity and deletion effect | Verify actual Drive deletion/trash behavior, ownership/role rules and recoverability; require explicit trusted destructive-action approval; do not claim local-hide or permanent erasure unless established |

Do not equate deleting content blocks with deleting the document. Resolve Wiki links only to supported content; Wiki node deletion is a separate operation. Content fidelity has explicit limits: start with text, headings, lists, links and basic tables after contract verification; embedded assets, advanced layouts and legacy formats must be marked unsupported rather than flattened silently.

Docs CRUD tests use disposable documents in an explicitly selected folder: create → read → update → reread → confirmed delete. Cover shared read-only documents, missing scopes, moved/deleted targets, pagination, Unicode, stale edits, partial multi-call updates and ambiguous timeouts. Avoid blind retries for creates or destructive operations. Record each operation's validation independently; message-send restrictions must not block Docs CRUD.

## 5. OSS confidential-client onboarding, not a bundled secret

The current [v3 token contract](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3) says third-party Open Platform registrations are confidential and require a secret; public-client registration is not open outside the official MCP exception. PKCE is additional protection, not permission to omit `client_secret`.

Future onboarding after explicit authorization:

1. Select Feishu China and confirm app ownership/developer role, tenant, app availability and permitted data flows. Inspect an existing app before creating another. No credentials need to be pasted into chat.
2. For each minimal bundle, record user-identity eligibility, effective/pending status and developer-debug exemption in the console. Supported developer U debugging can avoid publication; some sensitive scopes cannot. If unavailable, check review-free tenant policy or request normal approval. Do not promise a permanent personal-production exemption.
3. Create/select a BYO custom app, enabling bot capability only when needed. Do not join/invite it to any chat. Test enterprise grants do not prove access to production-tenant resources.
4. Register an exact loopback callback permitted by the provider. Do not assume dynamic ports or interchangeable `localhost`/`127.0.0.1`. Store the user's own app secret via a trusted local keychain prompt, not argv, git, logs, npm artifacts or a repository-selected path. Audit the keychain library before adoption; locked/unavailable keychain fails closed.
5. Browser consent uses random single-use state and S256 PKCE. A short-lived loopback listener validates path/Host/state, rejects replays and closes after completion; never bind all interfaces. Test the v3 exchange because older OAuth pages conflict.
6. Inspect returned scopes and identity; persist app/region/tenant/user binding. Use returned expiries, and request `offline_access` only for refresh. Serialize refresh across processes and atomically replace single-use refresh tokens with crash recovery; do not assume a fixed lifetime.
7. Show a token-free capability/status report, missing grants and resource-policy limitations. Local logout removes secrets; document provider-side revocation separately once verified. No silent reauthorization or scope broadening.

A shared vendor app would require a trusted backend to protect its secret; a secret embedded in distributed TS is not confidential. That alternative changes privacy/operations and is not this local plan. Environment injection is a possible bridge, not encryption or a preferred persistent credential store. Marketplace review-free installation is conditional and enterprise-wide, not personal-only. [Permissions/debugging](https://open.feishu.cn/document/server-docs/application-scope/introduction?lang=zh-CN), [Review policy](https://open.feishu.cn/document/best-practices/intro-to-custom-app-review), [Marketplace employee installation](https://open.feishu.cn/document/uAjLw4CM/uYjL24iN/platform-overveiw/develop-process/configuring-employee-review-free-installation)

## 6. Phases and explicit exit gates

| Phase | Work after separately authorized | Exit gate |
|---|---|---|
| 0A — design review | Confirm target clients, region, read workflows, app/tenant context, data handling and comparison method | User approves exact setup/testing scope; no implementation yet |
| 0B — documentary/console feasibility | Inspect minimal user scopes and approval status; map official Feishu endpoint contracts for direct HTTP adapters | Per-capability evidence distinguishes available, review-required, ineligible and unknown; no copied scope JSON treated as a grant |
| 0C — live read proof | Authorized OAuth and isolated direct-API reads in ordinary existing no-bot group, p2p and owned/shared document | Reproducible selected reads succeed as U with independently verified bot absence; failures documented without bot workaround; direct API behavior recorded |
| 1 — local read MVP | Build the independent TypeScript server, direct Feishu HTTP adapters, login/custody/policy and selected search/history/document tools | Security/contract/client tests pass; actual scopes/resource restrictions visible; no write tools callable; no plaintext secrets or stdout diagnostics |
| 1B — core Docs CRUD | Audit user-token Docx/Drive mutation contracts; implement approved create, targeted update and document-delete tools with trusted previews | Disposable-document create/read/update/delete cycle passes; permissions, content fidelity, concurrent edits and deletion semantics documented; no bot fallback; core Docs requirement cannot be marked complete with read-only tools |
| 2 — independent send feasibility | Check `im:message.send_as_user` eligibility; request separate consent for one exact sandbox send/reply | U sender and exact recipient/content confirmed, bot absent; if unavailable, record optional capability blocked and retain read release |
| 3 — controlled optional writes | Trusted prepare/commit approval, selected reaction or send tools; audit other writes independently | Approval binding/replay/timeout/idempotency tests pass; no model-only confirmation; unsupported tools remain denied |
| 4 — OSS release readiness | Select license holder/license; dependency lock, package inspection, CI/security documentation and support matrix | User explicitly authorizes publication/remote separately; scans/notices/interop pass; no secret-bearing fixtures or installer side effects |
| 5 — hosted, optional | Only a demonstrated remote-client need and new privacy/threat-model review | Separate MCP auth and Feishu auth, per-user isolation/custody, TLS/Origin and abuse/retention tests; separate deployment approval |

No phase is preauthorized merely because it appears here. A failed no-bot history gate can narrow an initial release to independently validated search/documents; it cannot relax the invariant. Explicitly label each capability documentary-only, mocked-contract-tested or live-validated with tested tenant/app/region/version/date.

## 7. Acceptance and adversarial tests

### Prove the bot stays absent

- Before tests, use the trusted Feishu UI or an authorized admin view to record that the existing ordinary test group contains the user but not the app bot. **Do not infer bot absence from `chats.members`: its API excludes bots.** Do not create an invite/join operation in the test harness.
- Capture content-minimized evidence: endpoint, identity class, app/profile, actual grants, group type/membership attestation and error/result metadata. Do not save tokens or private message bodies into this repo.
- Test group discovery, snippet search, group history/get, thread replies and p2p history independently. Verify expected handling of inaccessible old history, removed membership, invisible/deleted messages and scope revocation.
- Recheck bot absence after reads and before/after an independently approved send/reply. Verify sender is the consenting user in the UI. An authorized human witness may attest membership; do not acquire broad admin scopes just to automate evidence.
- Where generic bot-prerequisite docs conflict with explicit U support, retain the exact failure and seek clarification. Never retry as bot, invite it, or claim all tenants work from one success.

### Authentication, policy and protocol

- Wrong/missing/replayed state, PKCE mismatch, callback mismatch, Host/Origin abuse, code replay and expiry; verify newer token flow behavior, not only mocks.
- Concurrent refresh/process crash, partial credential writes, locked/unavailable keychain, logout/revocation, cross-app/tenant/region identity mismatch; no plaintext fallback.
- Exact AND/OR scopes, missing grants, stale grant/policy cache, unsupported user identity, write tool called despite hidden discovery, workspace config trying to broaden permissions.
- Search/body separation; Unicode/Chinese content; pagination/time/byte caps; cancellation; provider throttling and safe read retries; query/profile-bound opaque cursors.
- Hostile message/document instructions, token exfiltration, malicious URLs/redirects, oversized inputs; no arbitrary authenticated fetch or tool-policy changes from content.
- Selected-client stdio tool discovery/call/errors/cancellation/shutdown with pinned SDK client and Inspector; stdout contains only protocol data. Record protocol revisions and old-client compatibility outcomes.

### Writes and release

- Trusted human preview shows acting identity, resolved recipient and exact content. Expiring single-use approval binds user/profile, destination, payload hash and policy; forged/stale/cross-user handles fail. `confirm: true` from a model is insufficient; absent trusted channel means writes remain off.
- Test timeout after send, provider deduplication windows and reconciliation before any retry; no blind automatic send retry. Reply `uuid` is documented as one-hour deduplication, not perpetual exactly-once delivery.
- Secret scan logs, fixtures, git candidates and packed npm artifact; dependency/license audit, SBOM/notices, lockfile and supported Node/client matrix. No floating `npx -y ...@latest` release instructions or install hooks that authenticate/download unrelated binaries.
- Hosted tests, only if approved: issuer/audience/expiry/scope failures, cross-user isolation, confused deputy, redirect abuse, DNS rebinding/Origin, retention and revocation. Never treat official localhost OAuth mode as production multitenancy.

## 8. Open decisions and approval-dependent backlog

| Open item | Required evidence / decision |
|---|---|
| Target app/tenant and prior successful reads | User-selected app identity, developer role and known endpoint/scopes; do not assume past grants transfer |
| No-bot generic prerequisites | Live U-only ordinary-group history/get/send outcomes and, if needed, provider clarification |
| Minimal-approval route | Console eligibility per scope, developer exemption, app availability and tenant review rules; no universal exemption list asserted |
| User send availability | Exact scope request eligibility and tenant restriction; support escalation has no guaranteed outcome |
| DM coverage and restricted resources | Search is not exhaustive enumeration; history/retention/external-chat cases require individual checks |
| Attachment/plugin discrepancy | Public user-token route/entitlement before inclusion; no tenant-token workaround |
| Core Docs CRUD | Exact user-token Docx/Drive create/update/delete routes and minimal scopes; parent-folder access, supported block types, revision/concurrency behavior and delete/trash/recovery semantics; legacy Docs and Wiki-node lifecycle remain separate |
| Recall/reactions and other writes | Exact identity-specific scopes, ownership/windows and approved workflow; user message edit currently unestablished |
| OAuth details | Fixed callback acceptance, v3 S256/refresh/revocation behavior; public-client eligibility cannot be assumed |
| Lark global | Independent endpoints, scopes, OAuth/client status, review-policy and tenant audit |
| SDK/client/runtime and keychain | Recheck stable release, pin/test interoperability; audit keychain dependency and headless behavior |
| Release governance | License holder and license approval, maintainer/security contact, supported platforms and distribution; no remote or commit requested |

**Current next step:** connect the built local stdio command to the user's chosen MCP client, without silently editing global configuration. Broader live coverage and open-source release gates remain separate work. Message sending and document search are excluded because they required approval in the tested tenant.
