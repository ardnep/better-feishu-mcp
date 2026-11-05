import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CLIENT_ID = 'cli_aa61b5e398f81d00';
export const CALLBACK = 'http://127.0.0.1:52741/callback';
export const SCOPES = [
  'search:message', 'im:chat:read', 'im:message:readonly',
  'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user',
  'docx:document:readonly', 'docx:document:create',
  'docx:document:write_only', 'space:document:delete',
];

export function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function equalState(actual: string | null, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorization(options: { pkce?: boolean } = {}) {
  const pkce = options.pkce !== false;
  const state = randomBytes(32).toString('base64url');
  const verifier = pkce ? randomBytes(48).toString('base64url') : '';
  const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  url.search = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: CALLBACK,
    scope: SCOPES.join(' '), state, prompt: 'consent',
  }).toString();
  if (pkce) {
    url.searchParams.set('code_challenge', challenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return { state, verifier, pkce, url: url.toString() };
}

export function tokenRequest(session: ReturnType<typeof authorization>, secret: string, code: string) {
  const url = new URL(session.url);
  if (!secret || !code) throw new Error('Confidential-client credentials and code required');
  if (session.pkce && (!/^[A-Za-z0-9._~-]{43,128}$/.test(session.verifier)
    || url.searchParams.get('code_challenge_method') !== 'S256'
    || !equalState(url.searchParams.get('code_challenge'), challenge(session.verifier)))) {
    throw new Error('Invalid local PKCE exchange state');
  }
  if (!session.pkce && (url.searchParams.has('code_challenge') || url.searchParams.has('code_challenge_method'))) {
    throw new Error('Refusing inconsistent non-PKCE session');
  }
  return {
    grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: secret,
    code, redirect_uri: CALLBACK, ...(session.pkce ? { code_verifier: session.verifier } : {}),
    scope: SCOPES.join(' '),
  };
}
