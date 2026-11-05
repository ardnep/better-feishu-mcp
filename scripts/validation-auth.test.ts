import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorization, challenge, equalState, tokenRequest, SCOPES, CALLBACK } from './validation-auth.ts';

test('PKCE S256 matches RFC 7636 vector', () => {
  assert.equal(challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('token serialization retains the exact verifier and rejects a mismatched session', () => {
  const session = authorization();
  const payload = JSON.parse(JSON.stringify(tokenRequest(session, 'synthetic-test-secret', 'synthetic-code')));
  assert.equal(payload.code_verifier, session.verifier);
  assert.equal(challenge(payload.code_verifier), new URL(session.url).searchParams.get('code_challenge'));
  assert.equal(payload.redirect_uri, CALLBACK);
  assert.throws(() => tokenRequest({ ...session, verifier: authorization().verifier }, 'test', 'test'));
});
test('state fails closed for missing, empty, changed and different-length values', () => {
  assert.equal(equalState('abc', 'abc'), true);
  for (const candidate of [null, '', 'abd', 'abcd']) assert.equal(equalState(candidate, 'abc'), false);
  assert.equal(equalState('', ''), false);
});
test('authorization is user-only, bounded, fresh and excludes document search and refresh', () => {
  const a = authorization();
  const b = authorization();
  const url = new URL(a.url);
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.verifier, b.verifier);
  assert.ok(a.verifier.length >= 43 && a.verifier.length <= 128);
  assert.equal(url.origin, 'https://accounts.feishu.cn');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('code_challenge'), challenge(a.verifier));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new Set(SCOPES).size, 9);
  assert.ok(!SCOPES.includes('search:docs:read'));
  assert.ok(!SCOPES.includes('offline_access'));
  assert.ok(!a.url.includes('client_secret'));
});

test('explicit confidential-client non-PKCE mode retains state and secret, omits PKCE on both legs', () => {
  const session = authorization({ pkce: false });
  const url = new URL(session.url);
  const payload = tokenRequest(session, 'synthetic-secret', 'synthetic-code');
  assert.equal(session.pkce, false);
  assert.ok(session.state.length >= 32);
  assert.equal(url.searchParams.get('state'), session.state);
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.has('code_challenge'), false);
  assert.equal(url.searchParams.has('code_challenge_method'), false);
  assert.equal('code_verifier' in payload, false);
  assert.equal(payload.client_secret, 'synthetic-secret');
  assert.throws(() => tokenRequest(session, '', 'code'));
  const inconsistent = new URL(session.url);
  inconsistent.searchParams.set('code_challenge', 'unexpected');
  assert.throws(() => tokenRequest({ ...session, url: inconsistent.toString() }, 'secret', 'code'));
  assert.equal(authorization().pkce, true);
});
