// Real SDK client -> built CLI over stdio. No network by default.
// --live opts into existing-user fixture reads. --live-crud additionally authorizes
// this trusted test runner to sign operations ONLY for its newly created fixture.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { settings } from '../dist/core.js';
import { KeychainStore } from '../dist/credentials.js';
import { runtime } from '../dist/server.js';

const flags = new Set(process.argv.slice(2));
for (const flag of flags) assert.ok(['--live', '--live-crud'].includes(flag), 'Unknown test flag');
assert.ok(!flags.has('--live-crud') || flags.has('--live'), '--live-crud also requires --live');
const live = flags.has('--live'); const crud = flags.has('--live-crud');
const config = settings({ ...process.env, BETTER_FEISHU_MCP_ENABLE_WRITES: crud ? '1' : '0',
  ...(!live ? { BETTER_FEISHU_MCP_PROFILE: 'smoke_' + randomBytes(8).toString('hex') } : {}) });
const store = new KeychainStore(config.profile);
const session = live ? await store.load() : null;
if (live) assert.ok(session, 'Log in with the built CLI before running live tests');
const approver = live ? runtime(config, store).operations : null;
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'serve', '--stdio'],
  env: { ...process.env, BETTER_FEISHU_MCP_PROFILE: config.profile, BETTER_FEISHU_MCP_ENABLE_WRITES: crud ? '1' : '0' }, stderr: 'pipe' });
let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
const client = new Client({ name: 'better-feishu-mcp-stdio-validation', version: '0.1.0' });
const checks = []; let cleanupDocument;
function decode(response) {
  const item = response.content?.find(c => c.type === 'text'); assert.ok(item, 'Missing tool result'); return JSON.parse(item.text);
}
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }); const data = decode(response);
  if (response.isError) {
    const error = new Error(`${name}: ${data.error?.kind ?? 'TOOL_ERROR'}`); error.details = data.error; throw error;
  }
  return data;
}
async function commit(draft) {
  assert.ok(crud && approver, 'Fixture approvals require explicit --live-crud');
  await approver.approve(draft.operationId);
  return call('operations_commit', { operationId: draft.operationId });
}
async function cleanup() {
  if (!cleanupDocument) return;
  const meta = await call('documents_get', { documentId: cleanupDocument });
  const deletion = await call('documents_prepare_delete', { documentId: cleanupDocument, revision: meta.revision_id });
  const deleted = await commit(deletion); assert.equal(deleted.deleted, true);
  const deletedId = cleanupDocument;
  cleanupDocument = undefined; checks.push('docs_delete_to_recycle_bin');
  const probe = await client.callTool({ name: 'documents_get', arguments: { documentId: deletedId } });
  assert.equal(probe.isError, true, 'Deleted fixture should no longer be readable');
  assert.ok([1770002, 1770003, 1061003, 1061007].includes(decode(probe).error?.code), 'Expected a deleted/not-found provider error');
  checks.push('docs_post_delete_inaccessible');
}
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(t => t.name);
  assert.ok(tools.includes('messages_search') && tools.includes('documents_read'));
  assert.ok(!tools.some(t => /send|documents_search|operations_approve/.test(t)));
  assert.equal(tools.includes('operations_commit'), crud); checks.push('stdio_discovery_and_tool_policy');
  const status = await call('auth_status'); assert.equal(status.loggedIn, live);
  assert.ok(!('accessToken' in status) && !('appSecret' in status)); checks.push('token_free_status');
  if (!live) {
    const denied = await client.callTool({ name: 'messages_search', arguments: { query: 'fixture' } });
    assert.equal(denied.isError, true); assert.equal(decode(denied).error.kind, 'LOGIN_REQUIRED'); checks.push('unauthenticated_call_denied');
  } else {
    const groups = await call('chats_list', { limit: 50 });
    const chat = groups.items.find(item => item.name === 'better-feishu-mcp API test (temporary)');
    assert.ok(chat?.chat_id, 'Temporary bot-free fixture group not found in bounded group page'); checks.push('fixture_group_discovery');
    const found = await call('messages_search', { query: 'better-feishu-mcp', chatIds: [chat.chat_id], limit: 1 });
    assert.ok(found.items.length); checks.push('fixture_message_search');
    const history = await call('messages_history', { chatId: chat.chat_id, visibility: 'group', limit: 1 });
    assert.ok(history.items.length); checks.push('fixture_message_history');
    const message = await call('messages_get', { messageId: history.items[0].message_id, visibility: 'group' });
    assert.ok(JSON.stringify(message.items).includes('better-feishu-mcp API validation fixture')); checks.push('fixture_message_get_and_content');
    if (crud) {
      const before = 'better-feishu-mcp stdio fixture ' + randomBytes(8).toString('hex'); const after = before + ' updated';
      const draft = await call('documents_prepare_create', { title: 'better-feishu-mcp disposable stdio test', content: [{ type: 'paragraph', text: before }] });
      const denied = await client.callTool({ name: 'operations_commit', arguments: { operationId: draft.operationId } });
      assert.equal(denied.isError, true); assert.equal(decode(denied).error.kind, 'APPROVAL_REQUIRED'); checks.push('live_unapproved_write_denied');
      const created = await commit(draft); cleanupDocument = created.documentId; assert.ok(cleanupDocument); checks.push('docs_create_with_content');
      const read = await call('documents_read', { documentId: cleanupDocument }); assert.ok(read.text.includes(before)); checks.push('docs_read');
      const structured = await call('documents_blocks', { documentId: cleanupDocument, limit: 20 });
      const block = structured.blocks.find(b => b.block_type === 2 && JSON.stringify(b).includes(before)); assert.ok(block?.block_id); checks.push('docs_read_blocks');
      const edit = await call('documents_prepare_update', { documentId: cleanupDocument, revision: structured.document.revision_id,
        change: { type: 'replace_text', blockId: block.block_id, text: after } });
      await commit(edit); checks.push('docs_targeted_update');
      const reread = await call('documents_read', { documentId: cleanupDocument }); assert.ok(reread.text.includes(after)); checks.push('docs_verify_update');
      await cleanup();
    }
  }
} catch (error) {
  if (error.details?.kind === 'PARTIAL_WRITE' && error.details.documentId) cleanupDocument = error.details.documentId;
  process.exitCode = 1; console.error('Validation failed: ' + error.message);
} finally {
  if (cleanupDocument) {
    try { await cleanup(); } catch { process.exitCode = 1; console.error('Disposable document needs cleanup; its generated ID is in the local report.'); }
  }
  await client.close();
  if (session) for (const secret of [session.accessToken, session.appSecret, session.refreshToken].filter(Boolean)) assert.ok(!stderr.includes(secret), 'Credential appeared on stderr');
  const report = { date: new Date().toISOString(), live, crud, checks, success: !process.exitCode,
    ...(cleanupDocument ? { cleanupRequiredDocumentId: cleanupDocument } : {}) };
  await mkdir(new URL('../.runtime/', import.meta.url), { recursive: true, mode: 0o700 });
  await writeFile(new URL('../.runtime/' + (live ? 'mcp-stdio-live.json' : 'mcp-stdio-smoke.json'), import.meta.url), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
