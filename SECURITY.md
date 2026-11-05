# Security boundaries

This local alpha is not an independent security audit or an OS sandbox.

## Identity and credentials

- Feishu China only, fixed provider/API hosts and redirect refusal. No generic authenticated HTTP tool, bot-token acquisition, bot joining or identity fallback.
- User/app/tenant binding is established through the user-info API, saved in the OS keychain and checked on refresh. A changed login requires restarting the MCP process.
- App secrets, access/refresh tokens and approval signing keys are never deliberately written to source, configuration, logs or test reports. OS-keychain failure stops credential operations; no plaintext fallback. OS memory/core dumps and the user's browser/password manager remain outside this guarantee.
- S256 PKCE is the default login mode. An explicit `--auth-mode confidential` selects the documented app-secret flow without PKCE, needed in the tested environment after error 20049. Never downgrade automatically.
- Offline access is opt-in. Single-use refresh rotation is marked uncertain in the keychain before transmission. A crash/timeout fails closed and requires re-login. Local logout does not revoke the upstream provider grant.

## Writes and data

- Writes are disabled at startup by default. Enabled writes still require exact, expiring, identity-bound, HMAC-signed local approvals. No MCP approval tool and no `confirm` boolean bypass.
- Local CLI approvals require an interactive terminal. **A TTY is not proof of a human:** an unrestricted agent running as the same OS user could drive a terminal or read the keychain itself. Keep shell/computer/keychain access separately permissioned. The trusted fixture-test runner explicitly exercises approval signing only for its own disposable document.
- Once claimed, an operation cannot be automatically replayed after an error/crash. Receipts expose uncertain results. Creates/content insertion are not transactional; recovery may require inspecting the created document manually.
- Targeted edits preserve unrelated blocks, not necessarily formatting inside a replaced text block. Revision checks are best-effort preflight, not proven provider compare-and-swap or multi-call transactions. Shared editing races are not fully mitigated.
- Document-image writes accept bounded local PNG/JPEG files, never remote URLs or arbitrary attachments. Preparation exposes path/name/MIME/size/dimensions/SHA-256 to the trusted local approver; it does not upload. Approval binds those details and rereads the files; commit rechecks every file before any mutation and uploads the verified buffers. Local paths must be canonical regular files without symlink components. This is not a filesystem sandbox: a malicious same-user process can race or replace files, and a header check is not a full image decoder/antivirus. Inspect the source images before approving. Drafts store only metadata, not image bytes.
- Image upload uses only the authorized user token and requires media-upload scope in addition to document grants. No standalone upload tool exists. Each upload is bound to a newly created image block in the approved document, serialized, redirect-refusing and never automatically retried. Image insertion is multi-call and nontransactional: blank blocks or uploaded media may remain after failure; recovery identifiers are returned and stored in the receipt. No automatic rollback or replay is attempted.
- Document deletion is Drive recycle-bin deletion. No permanent erasure, restore or Wiki-node lifecycle feature is implemented.
- Feishu data is untrusted input. Descriptions/output flag it as data, never authorization or instructions. This reduces confusion but does not make an LLM immune to prompt injection or prevent exfiltration through other tools.
- Read requests are bounded by time, page count/size and response bytes. Cursors are process/query-bound and Docx cursors include the observed revision. Unsupported scope/resource access fails; it is not worked around.
- Attachment reads verify resource key/type against the source message before downloading from the fixed Feishu API host with the user token. No local download paths, external resource URLs, attachment writes or tenant-token fallback are exposed. Download size is capped at 5 MB, text at 100000 characters and images at 350 KB; image MIME is determined from bytes, not a provider-supplied filename.
- Untrusted PDF/DOCX parsing uses a separate worker with a 15-second deadline and a 128 MB old-generation JS heap limit. DOCX archive metadata is preflighted for at most 2000 entries/20 MB expanded size; PDF extraction is limited to 50 pages, with PDF JavaScript evaluation disabled. Worker diagnostics are drained privately, not forwarded to protocol stdout/stderr. These are resource guardrails, **not an OS sandbox or a total process-memory guarantee**. No OCR, macros, active HTML or CSV formulas are executed.

## Local storage and distribution

- Pending drafts hold proposed document content in private files (`0700` directory, `0600` files), not encryption-at-rest independently of the OS. Expiry is enforced at use; expired drafts are pruned on later preparation. Crash-claimed drafts and receipts need manual lifecycle management. Do not sync the state directory to a shared workspace.
- Lock directories serialize credential rotation and local mutations. Crash leftovers are not blindly deleted; inspect the owner/process before manual recovery.
- Node 24/macOS is the validated runtime. Other OS credential backends, shared documents, DM/thread cases, complex blocks, refresh, long-lived revocation and hostile local-account scenarios need further testing.
- The npm artifact allowlist excludes `.runtime`, tests, credentials and research notes. Keep the package private until license, notices, dependency/native-binary review, CI and release governance are complete. Never publish the user's app credentials.

## Reporting

There is no public repository or security contact yet. Report findings privately to the maintainer; do not include tokens, app secrets or private Feishu content in an issue. A reporting channel must be selected before public release.
