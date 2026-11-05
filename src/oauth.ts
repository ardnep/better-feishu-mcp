import { z } from 'zod';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { AppError, BASE_SCOPES, type AuthMode, type Settings, withLock } from './core.js';
import { type CredentialStore, type Session, sessionSchema } from './credentials.js';
import { boundedJson, type Fetch } from './http.js';

export const CALLBACK = 'http://127.0.0.1:52741/callback';
const TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
const tokenSchema = z.object({ code: z.literal(0), access_token: z.string().min(1), expires_in: z.number().positive(), scope: z.string(),
  refresh_token: z.string().optional(), refresh_token_expires_in: z.number().positive().optional() });
const identitySchema = z.object({ code: z.literal(0), data: z.object({ open_id: z.string().min(1), tenant_key: z.string().min(1) }) });
export function equal(a: string | null, b: string) { return !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export function authorize(appId: string, mode: AuthMode, offline = false) {
  const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
  const scopes = [...BASE_SCOPES, ...(offline ? ['offline_access'] : [])];
  const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  url.search = new URLSearchParams({ client_id: appId, response_type: 'code', redirect_uri: CALLBACK,
    scope: scopes.join(' '), state, prompt: 'consent' }).toString();
  if (mode === 'pkce') {
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  }
  return { state, verifier, scopes, url: url.toString() };
}
async function tokenCall(body: Record<string, string>, fetcher: Fetch) {
  let response: Response;
  try { response = await fetcher(TOKEN_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new AppError('OAUTH_NETWORK_ERROR', 'Token request failed; do not retry a single-use code or refresh token. Log in again.'); }
  const data = await boundedJson(response, 100_000);
  const parsed = tokenSchema.safeParse(data);
  if (!response.ok || !parsed.success) {
    const code = z.object({ code: z.number() }).safeParse(data);
    throw new AppError('OAUTH_ERROR', 'Feishu token exchange failed. No automatic auth-mode or identity fallback.', code.success ? { code: code.data.code } : {});
  }
  return parsed.data;
}
async function identity(token: string, fetcher: Fetch) {
  const response = await fetcher('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new AppError('IDENTITY_CHECK_FAILED', 'Could not establish the authorized user identity.');
  return identitySchema.parse(await boundedJson(response, 100_000)).data;
}
export async function refreshSession(session: Session, fetcher: Fetch = fetch): Promise<Session> {
  if (!session.refreshToken) throw new AppError('LOGIN_REQUIRED', 'No refresh token.');
  const issuedAt = Date.now();
  const tokens = await tokenCall({ grant_type: 'refresh_token', client_id: session.appId, client_secret: session.appSecret, refresh_token: session.refreshToken }, fetcher);
  const who = await identity(tokens.access_token, fetcher);
  if (who.open_id !== session.userId || who.tenant_key !== session.tenantId) throw new AppError('IDENTITY_MISMATCH', 'Refreshed token belongs to another identity.');
  if (!tokens.refresh_token || !tokens.refresh_token_expires_in) throw new AppError('LOGIN_REQUIRED', 'Provider did not rotate the refresh token. Log in again.');
  return { ...session, accessToken: tokens.access_token, expiresAt: issuedAt + tokens.expires_in * 1000,
    refreshToken: tokens.refresh_token, refreshExpiresAt: issuedAt + tokens.refresh_token_expires_in * 1000,
    scopes: tokens.scope.split(/\s+/).filter(Boolean), refreshState: 'active' };
}
function escape(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
function send(res: ServerResponse, status: number, content: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>better-feishu-mcp login</title><style>:root{color-scheme:light}body{font:16px/1.6 system-ui;background:#f5f5f1;color:#202a28;max-width:650px;margin:60px auto;padding:24px}main{background:white;padding:28px;border-radius:14px}input{box-sizing:border-box;width:100%;padding:10px;margin:6px 0 18px}button{background:#21634c;color:white;padding:12px 22px;border:0;border-radius:6px}small{color:#65706b}</style><main>${content}</main></html>`);
}
export async function login(options: { config: Settings; store: CredentialStore; appId: string; mode: AuthMode; offline: boolean;
  replace: boolean; onReady: (url: string) => void; fetcher?: Fetch }): Promise<void> {
  const { config, store, appId, mode } = options;
  const fetcher = options.fetcher ?? fetch;
  const flow = authorize(appId, mode, options.offline);
  const entry = '/' + randomBytes(24).toString('base64url');
  const csrf = randomBytes(32).toString('base64url'); const origin = new URL(CALLBACK).origin;
  let secret = ''; let started = false; let consumed = false; const deadline = Date.now() + 600_000;
  let finish: (error?: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => { finish = error => error ? reject(error) : resolve(); });
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) return send(res, 403, 'Invalid host.');
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'GET' && url.pathname === entry && !started) return send(res, 200,
        `<h1>Connect Feishu as you</h1><p>App: <code>${escape(appId)}</code> · Profile: ${escape(config.profile)}</p><p>${mode === 'pkce' ? 'S256 PKCE + app secret.' : '<strong>Explicit confidential-client mode: app secret + state, without PKCE.</strong>'}</p><p>${options.offline ? 'Persistent login requested: offline_access must be enabled in Feishu.' : 'No refresh token requested. Log in again when the session expires.'}</p><form method="post" action="${entry}/start" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><label>App Secret<input type="password" name="secret" required maxlength="512" autocomplete="off"></label><p><small>Stored only in your OS keychain after successful authorization. Selected results will be sent to your configured MCP client/model. No bot will join any chat.</small></p><button>Continue to Feishu consent</button></form>`);
      if (req.method === 'POST' && url.pathname === entry + '/start') {
        if (req.headers.origin !== origin || started || Date.now() > deadline) return send(res, 403, 'Invalid origin or expired/reused login.');
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(res, 413, 'Request too large.'); }
        const fields = new URLSearchParams(body);
        if (!equal(fields.get('csrf'), csrf)) return send(res, 403, 'Invalid CSRF token.');
        secret = fields.get('secret') ?? '';
        if (!secret || secret.length > 512) { secret = ''; return send(res, 400, 'Invalid app secret.'); }
        started = true;
        res.writeHead(303, { Location: flow.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/callback') {
        if (!started || consumed || Date.now() > deadline || !equal(url.searchParams.get('state'), flow.state)) return send(res, 403, 'Invalid, expired or reused OAuth callback.');
        consumed = true;
        if (url.searchParams.has('error')) throw new AppError('CONSENT_DECLINED', 'Feishu authorization was declined.');
        const code = url.searchParams.get('code'); if (!code) throw new AppError('OAUTH_ERROR', 'Missing authorization code.');
        const issuedAt = Date.now();
        const tokens = await tokenCall({ grant_type: 'authorization_code', client_id: appId, client_secret: secret,
          code, redirect_uri: CALLBACK, scope: flow.scopes.join(' '), ...(mode === 'pkce' ? { code_verifier: flow.verifier } : {}) }, fetcher);
        const who = await identity(tokens.access_token, fetcher);
        const next = sessionSchema.parse({ version: 1, region: 'feishu.cn', profile: config.profile, appId, appSecret: secret,
          userId: who.open_id, tenantId: who.tenant_key, loginId: randomUUID(), approvalKey: randomBytes(32).toString('base64url'),
          authMode: mode, accessToken: tokens.access_token, expiresAt: issuedAt + tokens.expires_in * 1000,
          scopes: tokens.scope.split(/\s+/).filter(Boolean), refreshToken: options.offline ? tokens.refresh_token : undefined,
          refreshExpiresAt: options.offline && tokens.refresh_token_expires_in ? issuedAt + tokens.refresh_token_expires_in * 1000 : undefined, refreshState: 'active' });
        await withLock(config, 'credentials', async () => {
          const previous = await store.load();
          if (previous && !options.replace && (previous.appId !== appId || previous.userId !== who.open_id || previous.tenantId !== who.tenant_key)) {
            throw new AppError('IDENTITY_MISMATCH', 'Login would change this profile identity. Use a separate profile or explicitly pass --replace.');
          }
          await store.save(next);
        });
        secret = '';
        res.setHeader('Referrer-Policy', 'no-referrer');
        send(res, 200, '<h1>Connected.</h1><p>User credentials are in the OS keychain. You may close this tab.</p><p>Restart any running MCP server after a new login. Local logout removes credentials; provider authorization can be revoked separately in Feishu.</p>');
        finish(); return;
      }
      send(res, 404, 'Not found.');
    } catch (error) {
      secret = '';
      const message = error instanceof AppError ? escape(error.message) + (typeof error.details.code === 'number' ? ` (code ${error.details.code})` : '') : 'Login failed. No credentials were logged.';
      if (!res.headersSent) send(res, 400, `<h1>Not connected.</h1><p>${message}</p>`); else res.end();
      finish(error);
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  const timer = setTimeout(() => finish(new AppError('LOGIN_TIMEOUT', 'Login expired.')), 600_000);
  const stop = () => finish(new AppError('CANCELLED', 'Login cancelled.'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.once('error', () => finish(new AppError('PORT_IN_USE', 'Cannot bind 127.0.0.1:52741. Stop another login listener first.')));
  server.listen(52741, '127.0.0.1', () => { try { options.onReady(origin + entry); } catch (error) { finish(error); } });
  try { await completed; }
  finally { clearTimeout(timer); secret = ''; server.closeAllConnections(); server.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
