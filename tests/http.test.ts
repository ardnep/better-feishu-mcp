import { it, expect } from 'vitest';
import { z } from 'zod';
import { boundedJson, FeishuHttp } from '../src/http.js';
import { fakeFetch, json, session } from './helpers.js';

it('uses only the user token, rejects missing grants before any request', async () => {
  let count = 0;
  const api = new FeishuHttp(async () => session({ scopes: [] }), fakeFetch(() => { count++; return json({}); }), 0);
  await expect(api.request('GET', '/im/v1/chats', z.object({}), { scopes: ['im:chat:read'] })).rejects.toMatchObject({ kind: 'MISSING_SCOPE' });
  expect(count).toBe(0);
});
it('pins authenticated origin and refuses redirects', async () => {
  const api = new FeishuHttp(async () => session(), fakeFetch((url, init) => {
    expect(url.origin).toBe('https://open.feishu.cn'); expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-user-token-never-live');
    return json({ ok: true });
  }), 0);
  await expect(api.request('GET', '/im/v1/chats', z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
  for (const path of ['https://evil.com', '//evil', '/../../evil', '/a\\evil']) await expect(api.request('GET', path, z.object({}))).rejects.toMatchObject({ kind: 'INVALID_ENDPOINT' });
});
it('does not retry an ambiguous write or return a private upstream message', async () => {
  let count = 0;
  const api = new FeishuHttp(async () => session(), fakeFetch(() => { count++; throw new Error('private detail'); }), 0);
  await expect(api.request('POST', '/docx/v1/documents', z.object({}))).rejects.toMatchObject({ kind: 'NETWORK_ERROR' });
  expect(count).toBe(1);
  const denied = new FeishuHttp(async () => session(), fakeFetch(() => new Response(JSON.stringify({ code: 999, msg: 'private detail' }), { status: 403 })), 0);
  await expect(denied.request('GET', '/im/v1/chats', z.object({}))).rejects.toMatchObject({ kind: 'FEISHU_ERROR', details: { code: 999 } });
});
it('retries a rate-limited safe search but not mutation POSTs', async () => {
  let count = 0;
  const fetcher = fakeFetch(() => ++count === 1 ? json({}, 99991400, 429) : json({ ok: true }));
  const api = new FeishuHttp(async () => session(), fetcher, 0);
  await expect(api.request('POST', '/im/v1/messages/search', z.object({ ok: z.boolean() }), { safeRead: true })).resolves.toEqual({ ok: true });
  expect(count).toBe(2);
});
it('caps streamed bytes and rejects invalid JSON', async () => {
  await expect(boundedJson(new Response('x'.repeat(100)), 50)).rejects.toMatchObject({ kind: 'RESPONSE_TOO_LARGE' });
  await expect(boundedJson(new Response('not-json'))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
});
it('downloads bounded resources, preserving real JSON files and sanitizing provider errors', async () => {
  const path = '/im/v1/messages/om_fixture/resources/file_fixture?type=file';
  const file = new FeishuHttp(async () => session(), fakeFetch(() => new Response('{"code":123}', {
    headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="data.json"' },
  })), 0);
  expect((await file.download(path)).toString()).toBe('{"code":123}');
  const error = new FeishuHttp(async () => session(), fakeFetch(() => new Response('{"code":123,"msg":"private"}', {
    headers: { 'content-type': 'application/json' },
  })), 0);
  await expect(error.download(path)).rejects.toMatchObject({ kind: 'FEISHU_ERROR', details: { code: 123 } });
  const oversized = new FeishuHttp(async () => session(), fakeFetch(() => new Response(new Uint8Array(5_000_001))), 0);
  await expect(oversized.download(path)).rejects.toMatchObject({ kind: 'RESPONSE_TOO_LARGE' });
  const denied = new FeishuHttp(async () => session(), fakeFetch(() => new Response('{"code":403,"msg":"private"}', { status: 403 })), 0);
  await expect(denied.download(path)).rejects.toMatchObject({ kind: 'FEISHU_ERROR', details: { httpStatus: 403 } });
});
