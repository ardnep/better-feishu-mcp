// Temporary, dependency-free validation harness, not the production MCP/auth implementation.
// Native Node TypeScript execution; all app secrets and OAuth tokens remain in process memory.
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { authorization, CALLBACK, CLIENT_ID, equalState, SCOPES, tokenRequest } from './validation-auth.ts';

const origin = new URL(CALLBACK).origin;
const entry = '/' + randomBytes(24).toString('base64url');
const selectedTemporaryGroup = process.env.FEISHU_TEST_CHAT_NAME ?? '';
// Explicitly approved on 2026-11-04 for confidential-client API validation only.
// Never automatically downgrade a failed PKCE attempt.
const usePkce = process.env.FEISHU_VALIDATION_WITHOUT_PKCE !== '1';
const csrf = randomBytes(32).toString('base64url');
const reportPath = new URL('../.runtime/api-validation.json', import.meta.url);
type Result = { test: string; status: 'pass' | 'fail' | 'skipped'; detail?: string; code?: number; count?: number };
const results: Result[] = [];
let stage = 'waiting-for-local-credentials';
let pending: ReturnType<typeof authorization> | undefined;
let secret = '';
let allowCrud = false;
let chatId = '';
let attestBotAbsent = false;
let folderId = '';
let expiresAt = 0;
let cleanupDocument: string | undefined;
let submitted = false;
let callbackUsed = false;

class ApiFailure extends Error {
  code: number;
  constructor(code: number) { super('Provider request failed'); this.code = code; }
}
function html(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
    'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
  res.end(body);
}
function page(body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>better-feishu-mcp API validation</title><style>:root{color-scheme:light}body{background:#f5f5f1;color:#202a28;font:16px/1.6 system-ui;margin:40px auto;max-width:740px;padding:24px}main{background:white;padding:30px;border-radius:14px}input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:10px;margin:6px 0 16px;border:1px solid #ccc;border-radius:6px}button{background:#21634c;color:white;border:0;padding:12px 20px;border-radius:6px;cursor:pointer}small{color:#63716a}li{margin:8px 0}code{font-size:13px;overflow-wrap:anywhere}</style><main>${body}</main></html>`;
}
async function saveReport() {
  await mkdir(new URL('../.runtime/', import.meta.url), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, JSON.stringify({ date: new Date().toISOString(), stage,
    identity: 'user_access_token', appId: CLIENT_ID, requestedScopes: SCOPES,
    authenticationProtection: usePkce ? 'client secret + state + S256 PKCE' : 'client secret + state; non-PKCE explicitly user-approved for validation',
    noBotMembership: chatId && selectedTemporaryGroup && process.env.FEISHU_TEST_CHAT_UI_VERIFIED === '1'
      ? 'Agent-created temporary group; sole user and bot absence checked in Feishu UI before tests'
      : attestBotAbsent ? 'user-attested for selected chat; not independently verified' : 'not verified',
    results, ...(cleanupDocument ? { cleanupRequiredDocumentId: cleanupDocument } : {}),
  }, null, 2), { mode: 0o600 });
}
async function check(name: string, work: () => Promise<void>) {
  try { await work(); results.push({ test: name, status: 'pass' }); }
  catch (e) { results.push({ test: name, status: 'fail', ...(e instanceof ApiFailure ? { code: e.code } : { detail: 'Network, shape, or assertion failure; no private response retained.' }) }); }
  await saveReport();
}
async function validate(token: string) {
  let lastCall = 0;
  async function api(method: string, path: string, body?: unknown): Promise<any> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
    await sleep(Math.max(0, 450 - (Date.now() - lastCall)));
    lastCall = Date.now();
    const response = await fetch('https://open.feishu.cn/open-apis' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json() as any;
    if (!response.ok || payload.code !== 0) throw new ApiFailure(Number(payload.code ?? response.status));
    return payload.data;
  }
  await check('joined_groups', async () => {
    let cursor = '';
    let seen = 0;
    for (let page = 0; page < (selectedTemporaryGroup && !chatId ? 5 : 1); page++) {
      const query = new URLSearchParams({ page_size: selectedTemporaryGroup ? '100' : '5' });
      if (cursor) query.set('page_token', cursor);
      const data = await api('GET', '/im/v1/chats?' + query);
      if (!Array.isArray(data?.items)) throw new Error('Unexpected shape');
      seen += data.items.length;
      if (!chatId && selectedTemporaryGroup) {
        const matches = data.items.filter((item: any) => item.name === selectedTemporaryGroup);
        if (matches.length > 1) throw new Error('Ambiguous test group');
        if (matches.length === 1) { chatId = matches[0].chat_id; break; }
      }
      if (!selectedTemporaryGroup || !data.has_more || !data.page_token) break;
      cursor = data.page_token;
    }
    results.push({ test: 'joined_groups_sample_count', status: 'pass', count: seen });
    if (selectedTemporaryGroup) results.push({ test: 'temporary_group_discovery', status: chatId ? 'pass' : 'fail' });
  });
  await check('message_search', async () => {
    const data = await api('POST', '/im/v1/messages/search?page_size=1', {
      query: 'better-feishu-mcp', ...(chatId ? { filter: { chat_ids: [chatId] } } : {}),
    });
    if (!Array.isArray(data?.items)) throw new Error('Unexpected shape');
    results.push({ test: 'search_sample_count', status: 'pass', count: data.items.length });
  });
  if (chatId) {
    let messageId: string | undefined;
    await check('selected_chat_history', async () => {
      const data = await api('GET', '/im/v1/messages?' + new URLSearchParams({ container_id_type: 'chat', container_id: chatId, page_size: '1', sort_type: 'ByCreateTimeDesc' }));
      if (!Array.isArray(data?.items)) throw new Error('Unexpected shape');
      messageId = data.items[0]?.message_id;
      results.push({ test: 'history_sample_count', status: 'pass', count: data.items.length });
    });
    if (messageId) await check('message_get', async () => { await api('GET', `/im/v1/messages/${encodeURIComponent(messageId!)}`); });
    else results.push({ test: 'message_get', status: 'skipped', detail: 'No message ID obtained.' });
  } else results.push({ test: 'history_and_get', status: 'skipped', detail: 'No selected chat ID; no arbitrary chat inspected.' });

  if (allowCrud) {
    const before = 'Temporary API validation — 创建读取测试';
    const after = 'Updated API validation — 更新测试';
    try {
      await check('docs_create', async () => {
        const data = await api('POST', '/docx/v1/documents', {
          title: `better-feishu-mcp disposable API test ${new Date().toISOString()}`,
          ...(folderId ? { folder_token: folderId } : {}),
        });
        if (!data?.document?.document_id) throw new Error('Missing document ID');
        cleanupDocument = data.document.document_id;
      });
      if (cleanupDocument) {
        const id = encodeURIComponent(cleanupDocument);
        let block: string | undefined;
        await check('docs_insert_content', async () => {
          const data = await api('POST', `/docx/v1/documents/${id}/blocks/${id}/children?document_revision_id=-1`, {
            children: [{ block_type: 2, text: { elements: [{ text_run: { content: before } }] } }], index: -1,
          });
          block = data?.children?.[0]?.block_id;
          if (!block) throw new Error('Missing block');
        });
        await check('docs_read_text', async () => {
          const data = await api('GET', `/docx/v1/documents/${id}/raw_content`);
          if (!data?.content?.includes(before)) throw new Error('Content mismatch');
        });
        await check('docs_read_blocks', async () => {
          const data = await api('GET', `/docx/v1/documents/${id}/blocks?page_size=20`);
          if (!Array.isArray(data?.items)) throw new Error('Unexpected shape');
        });
        if (block) {
          await check('docs_update', async () => {
            await api('PATCH', `/docx/v1/documents/${id}/blocks/batch_update?document_revision_id=-1&client_token=${randomUUID()}`, {
              requests: [{ block_id: block, update_text_elements: { elements: [{ text_run: { content: after } }] } }],
            });
          });
          await check('docs_verify_update', async () => {
            const data = await api('GET', `/docx/v1/documents/${id}/raw_content`);
            if (!data?.content?.includes(after) || data.content.includes(before)) throw new Error('Content mismatch');
          });
        }
      }
    } finally {
      if (cleanupDocument) await check('docs_delete_to_recycle_bin', async () => {
        await api('DELETE', `/drive/v1/files/${encodeURIComponent(cleanupDocument!)}?type=docx`);
        cleanupDocument = undefined;
      });
    }
  } else results.push({ test: 'docs_crud', status: 'skipped', detail: 'Disposable-document test not selected.' });
  results.push({ test: 'sending_and_document_search', status: 'skipped', detail: 'Not requested; no sending or document-search scope used.' });
}

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== new URL(origin).host) return send(res, 403, 'Invalid host');
    const url = new URL(req.url ?? '/', origin);
    if (req.method === 'GET' && url.pathname === entry) {
      return send(res, 200, page(`<h1>Validate Feishu APIs</h1><p>Temporary local test. Credentials and tokens stay in memory; only token-free results are saved.</p><form method="post" action="${entry}/start"><input type="hidden" name="csrf" value="${csrf}"><label>App ID<input value="${CLIENT_ID}" readonly></label><label>App Secret<input type="password" name="secret" required autocomplete="off" maxlength="512"></label><label>Optional test chat ID<input name="chat" placeholder="oc_… (leave blank to skip history)"></label><label><input type="checkbox" name="no_bot"> I confirm the selected chat does not contain the app bot.</label><p><label><input type="checkbox" name="crud"> Create, read, update and delete one disposable test document. Never modify existing documents.</label></p><label>Optional destination folder token<input name="folder" placeholder="Leave blank for your root folder"></label><p><small>Deletion moves only the newly created test document to the recycle bin. No message sending, document search, refresh token or permanent archive.</small></p><button>Continue to Feishu consent</button></form>`));
    }
    if (req.method === 'POST' && url.pathname === entry + '/start') {
      if (req.headers.origin !== origin || submitted) return send(res, 403, 'Invalid origin or session already started');
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return send(res, 413, 'Request too large'); }
      const form = new URLSearchParams(raw);
      if (!equalState(form.get('csrf'), csrf)) return send(res, 403, 'Invalid CSRF token');
      const candidate = form.get('secret') ?? '';
      const chat = form.get('chat')?.trim() ?? '';
      const folder = form.get('folder')?.trim() ?? '';
      if (!candidate || candidate.length > 512 || (chat && !/^oc_[A-Za-z0-9_-]+$/.test(chat)) || (folder && !/^[A-Za-z0-9_-]+$/.test(folder))) return send(res, 400, 'Check secret, chat ID or folder token');
      if (chat && form.get('no_bot') !== 'on') return send(res, 400, 'Please confirm bot absence or leave the chat ID blank.');
      secret = candidate; chatId = chat; folderId = folder;
      allowCrud = form.get('crud') === 'on'; attestBotAbsent = !!chat && form.get('no_bot') === 'on';
      submitted = true; pending = authorization({ pkce: usePkce }); expiresAt = Date.now() + 10 * 60_000;
      stage = 'waiting-for-user-consent';
      res.writeHead(303, { Location: pending.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/callback') {
      if (!pending || callbackUsed || Date.now() > expiresAt || !equalState(url.searchParams.get('state'), pending.state)) return send(res, 403, 'Invalid, expired or replayed OAuth callback');
      callbackUsed = true;
      if (url.searchParams.has('error')) { secret = ''; pending = undefined; stage = 'consent-denied'; await saveReport(); return send(res, 403, page('<h1>Authorization was declined.</h1><p>No API tests ran.</p>')); }
      const code = url.searchParams.get('code');
      if (!code) { secret = ''; pending = undefined; stage = 'missing-authorization-code'; await saveReport(); return send(res, 400, 'Missing code'); }
      stage = 'exchanging-user-token';
      let response: Response;
      try {
        response = await fetch('https://accounts.feishu.cn/oauth/v3/token', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
          // JSON is explicitly supported by Feishu v3. Verify the local PKCE binding
          // before sending and test this encoding after the form exchange returned 20049.
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tokenRequest(pending, secret, code)),
        });
      } finally { secret = ''; pending = undefined; }
      const payload = await response.json() as any;
      if (!response.ok || payload.code !== 0 || typeof payload.access_token !== 'string') {
        results.push({ test: 'oauth_exchange', status: 'fail', code: Number(payload.code ?? response.status) });
        stage = 'authentication-failed'; await saveReport();
      } else {
        const granted = new Set(String(payload.scope ?? '').split(' '));
        results.push({ test: 'oauth_exchange', status: 'pass' });
        results.push({ test: 'requested_scopes_granted', status: SCOPES.every(s => granted.has(s)) ? 'pass' : 'fail',
          detail: 'Missing scopes: ' + SCOPES.filter(s => !granted.has(s)).join(', ') });
        stage = 'testing';
        const token = payload.access_token;
        delete payload.access_token; delete payload.refresh_token;
        try { await validate(token); stage = 'complete'; }
        catch { stage = 'validation-interrupted'; }
        await saveReport();
      }
      res.writeHead(303, { Location: entry + '/status', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === entry + '/status') {
      return send(res, 200, page(`<h1>API validation: ${html(stage)}</h1><ul>${results.map(r => `<li><strong>${html(r.status.toUpperCase())}</strong> ${html(r.test)}${r.code ? ' — code ' + r.code : ''}${r.detail ? '<br><small>' + html(r.detail) + '</small>' : ''}</li>`).join('')}</ul>${cleanupDocument ? '<p>Cleanup needs attention: disposable document ID <code>' + html(cleanupDocument) + '</code>.</p>' : ''}<p>No tokens or private message content are included in this report.</p>`));
    }
    return send(res, 404, 'Not found');
  } catch { secret = ''; stage = 'local-harness-error'; await saveReport().catch(() => {}); if (!res.headersSent) send(res, 500, 'Validation interrupted; inspect the token-free local report.'); else res.end(); }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.on('error', () => { console.error('Cannot start validation listener. Check whether port 52741 is occupied.'); process.exitCode = 1; });
server.listen(52741, '127.0.0.1', () => {
  console.log('LOCAL_VALIDATION_URL=' + origin + entry);
  console.log('REGISTER_CALLBACK=' + CALLBACK);
  console.log('Tokens and secrets are memory-only. Listener expires in 15 minutes.');
});
setTimeout(() => { secret = ''; pending = undefined; server.closeAllConnections(); server.close(); }, 15 * 60_000).unref();
process.once('SIGTERM', () => { secret = ''; pending = undefined; server.closeAllConnections(); server.close(); });
