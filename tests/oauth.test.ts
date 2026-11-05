import { it, expect } from 'vitest';
import { authorize, CALLBACK, equal, login, refreshSession } from '../src/oauth.js';
import { BASE_SCOPES } from '../src/core.js';
import { MemoryStore, fakeFetch, session, setup } from './helpers.js';

it('uses confidential-client auth by default and never adds PKCE parameters', () => {
  const confidential = new URL(authorize('cli_synthetic').url);
  expect(confidential.searchParams.has('code_challenge')).toBe(false);
  expect(confidential.searchParams.has('code_challenge_method')).toBe(false);
  expect(confidential.searchParams.get('scope')).not.toContain('offline_access');
  expect(authorize('cli_synthetic', 'confidential', true).scopes).toContain('offline_access');
  expect(() => authorize('cli_synthetic', 'pkce' as never)).toThrow();
  expect(equal(null, 'x')).toBe(false); expect(equal('x', 'y')).toBe(false);
});
it('runs a protected local login callback and saves only an identity-bound credential record', async () => {
  const { config, cleanup } = await setup(); const store = new MemoryStore(null);
  let ready!: (url: string) => void; const opening = new Promise<string>(resolve => { ready = resolve; });
  const finished = login({ config, store, appId: 'cli_synthetic', offline: false, replace: false, onReady: ready,
    fetcher: fakeFetch((url, init) => {
      if (url.pathname.endsWith('/token')) {
        const payload = JSON.parse(String(init.body));
        expect(payload.client_secret).toBe('synthetic-local-input');
        expect(payload.redirect_uri).toBe(CALLBACK); expect(payload.code_verifier).toBeUndefined();
        return new Response(JSON.stringify({ code: 0, access_token: 'synthetic-user-token', expires_in: 3600, scope: BASE_SCOPES.join(' '),
          refresh_token: 'unsolicited-refresh-must-be-discarded', refresh_token_expires_in: 10000 }));
      }
      expect(url.pathname).toBe('/open-apis/authen/v1/user_info');
      return new Response(JSON.stringify({ code: 0, data: { open_id: 'ou_synthetic', tenant_key: 'tenant_synthetic' } }));
    }) });
  try {
    const start = await opening; const origin = new URL(start).origin;
    const page = await fetch(start); expect(page.headers.get('referrer-policy')).toBe('same-origin');
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    expect((await fetch(origin + '/callback?state=wrong&code=wrong')).status).toBe(403);
    expect((await fetch(start + '/start', { method: 'POST', body: 'csrf=bad&secret=bad' })).status).toBe(403);
    const response = await fetch(start + '/start', { method: 'POST', redirect: 'manual', headers: { Origin: origin },
      body: new URLSearchParams({ csrf, secret: 'synthetic-local-input' }) });
    expect(response.status).toBe(303);
    const authorization = new URL(response.headers.get('location')!);
    const callback = new URL(CALLBACK); callback.search = new URLSearchParams({ code: 'synthetic-code', state: authorization.searchParams.get('state')! }).toString();
    const completed = await fetch(callback);
    expect(completed.status).toBe(200); await completed.text(); await finished;
    expect(store.value).toMatchObject({ appId: 'cli_synthetic', userId: 'ou_synthetic', tenantId: 'tenant_synthetic', authMode: 'confidential' });
    expect(store.value?.refreshToken).toBeUndefined();
  } finally { await cleanup(); }
});
it('refresh rotates credentials and checks user identity', async () => {
  const old = session({ refreshToken: 'synthetic-refresh', refreshExpiresAt: Date.now() + 100000 });
  const next = await refreshSession(old, fakeFetch((url, init) => {
    if (url.pathname.endsWith('/token')) {
      expect(JSON.parse(String(init.body)).grant_type).toBe('refresh_token');
      return new Response(JSON.stringify({ code: 0, access_token: 'next', expires_in: 3600, scope: BASE_SCOPES.join(' '), refresh_token: 'rotated', refresh_token_expires_in: 5000 }));
    }
    return new Response(JSON.stringify({ code: 0, data: { open_id: old.userId, tenant_key: old.tenantId } }));
  }));
  expect(next.refreshToken).toBe('rotated'); expect(next.loginId).toBe(old.loginId);
});
