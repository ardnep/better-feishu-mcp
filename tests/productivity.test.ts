import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { writeFile, symlink, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { productivityTools } from '../src/productivity-tools.js';
import { endpoint } from '../src/productivity.js';
import { sheetValuesSchema } from '../src/sheet-tools.js';
import { uploadForm, downloadFile } from '../src/transfers.js';
import { runtime } from '../src/server.js';
import { FeishuHttp } from '../src/http.js';
import { fakeFetch, json, MemoryStore, session, setup } from './helpers.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(writes = true, scopes = productivityTools.flatMap(t => t.scopes.flatMap(s => typeof s === 'string' ? [s] : [...s]))) {
  const env = await setup(writes); cleanups.push(env.cleanup); let calls = 0;
  const requests: { url: URL; init: RequestInit }[] = [];
  const store = new MemoryStore(session({ scopes }));
  const app = runtime(env.config, store, fakeFetch((url, init) => { calls++; requests.push({ url, init }); return json({ items: [], has_more: false }); }));
  return { ...env, app, store, requests, calls: () => calls };
}
const values: Record<string, unknown> = {
  spaceId: '123', targetSpaceId: '456', calendarId: 'fixture@group.calendar.feishu.cn', boardId: 'a'.repeat(24),
  chatId: 'oc_fixture', messageId: 'om_fixture', emojiType: 'SMILE', type: 'docx', objectType: 'docx', fileType: 'docx',
  fileExtension: 'docx', anchorTime: '100', startTime: '100', endTime: '200', timeMin: '2026-11-20T10:00:00Z', timeMax: '2026-11-20T11:00:00Z',
  start_time: { timestamp: '100' }, end_time: { timestamp: '200' }, values: [[42]], range: 'A1',
  nodeIds: ['c1:1'], fields: { Name: 'fixture' }, field: { field_name: 'fixture', type: 1 }, files: [{ fileToken: 'fixture', type: 'docx' }],
};
function sample(schema: Record<string, any>, key = ''): unknown {
  if (schema.enum) return schema.enum.includes(values[key]) ? values[key] : (schema.default ?? schema.enum[0]);
  if (key in values) return values[key];
  if (schema.const !== undefined) return schema.const;
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).filter((k: string) => k !== 'cursor').map((k: string) => [k, sample(schema.properties[k], k)]));
  if (schema.type === 'array') return [sample(schema.items)];
  if (schema.type === 'number' || schema.type === 'integer') return schema.default ?? schema.minimum ?? 1;
  if (schema.type === 'boolean') return schema.default ?? false;
  return 'fixture';
}
for (const tool of productivityTools) {
  if (/upload|download/.test(tool.name)) continue;
  it(`${tool.name}: strict schema, fixed route, scoped user request and write policy`, async () => {
    const f = await fixture();
    const input = sample(z.toJSONSchema(tool.schema) as Record<string, any>) as Record<string, unknown>;
    expect(tool.schema.safeParse({ ...input, arbitraryUrl: 'https://evil.invalid' }).success).toBe(false);
    const result = await tool.invoke(f.app, input);
    expect(result).toMatchObject({ untrustedData: true }); expect(f.calls()).toBe(1);
    expect(f.requests[0]!.url.origin).toBe('https://open.feishu.cn');
    expect(f.requests[0]!.init.redirect).toBe('error');
    expect(new Headers(f.requests[0]!.init.headers).get('authorization')).toBe('Bearer synthetic-user-token-never-live');
    f.store.value!.scopes = [];
    await expect(tool.invoke(f.app, input)).rejects.toMatchObject({ kind: 'MISSING_SCOPE' }); expect(f.calls()).toBe(1);
    f.app.config.writes = false;
    if (tool.write) await expect(tool.invoke(f.app, input)).rejects.toMatchObject({ kind: 'WRITES_DISABLED' });
  });
}
it('all tools have unique names and no forbidden product operations', () => {
  expect(new Set(productivityTools.map(t => t.name)).size).toBe(productivityTools.length);
  expect(productivityTools.some(t => /send|tasks_create|tasks_complete|tasklists_create|documents_search/.test(t.name))).toBe(false);
});
it('accounts for every reviewed extra scope without adding excluded capabilities', async () => {
  const pack = JSON.parse(await readFile(new URL('../docs/permission-packs/productivity-user-scopes.json', import.meta.url), 'utf8'));
  const implemented = new Set(productivityTools.flatMap(t => t.scopes.flatMap(s => typeof s === 'string' ? [s] : [...s])));
  implemented.add('sheets:spreadsheet:read'); implemented.add('sheets:spreadsheet.meta:read'); // Existing Sheets adapter.
  const blocked = new Set(['board:whiteboard:node:update']);
  for (const scope of pack.scopes) expect(implemented.has(scope) || blocked.has(scope), scope).toBe(true);
  for (const scope of pack.excluded) expect(implemented.has(scope), scope).toBe(false);
});
it('normalizes absent nodes on an empty board after deletion', async () => {
  const f = await fixture();
  f.store.value!.scopes.push('board:whiteboard:node:read');
  expect(await f.app.boards.nodes({ boardId: 'a'.repeat(24) })).toMatchObject({ nodes: [], totalNodes: 0 });
});
it('reports provider content-review rejection without mislabeling it as missing consent', async () => {
  const f = await fixture();
  const api = new FeishuHttp(() => f.app.sessions.token(), fakeFetch(() => json({}, 1069302, 400)), 0);
  await expect(api.request('POST', '/fixture', z.unknown())).rejects.toMatchObject({ kind: 'FEISHU_ERROR', message: expect.stringContaining('content review') });
});
it('opaque pagination binds identity, filters, tool and limit; rejects malformed provider continuation', async () => {
  const f = await fixture(); const tool = productivityTools.find(t => t.name === 'base_tables_list')!;
  let queries: URL[] = [];
  f.app.api = new FeishuHttp(() => f.app.sessions.token(), fakeFetch(url => { queries.push(url); return json({ items: [], has_more: true, page_token: 'private-provider-token', sync_token: 'private-sync' }); }), 0);
  const first = await tool.invoke(f.app, { appToken: 'app', limit: 1 }) as any;
  expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{32}$/); expect(JSON.stringify(first)).not.toContain('private');
  await tool.invoke(f.app, { appToken: 'app', limit: 1, cursor: first.nextCursor });
  expect(queries[1]!.searchParams.get('page_token')).toBe('private-provider-token');
  for (const input of [{ appToken: 'other', limit: 1 }, { appToken: 'app', limit: 2 }]) await expect(tool.invoke(f.app, { ...input, cursor: first.nextCursor })).rejects.toMatchObject({ kind: 'INVALID_CURSOR' });
  f.store.value!.userId = 'ou_other';
  await expect(tool.invoke(f.app, { appToken: 'app', limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ kind: 'INVALID_CURSOR' });
  f.app.api = new FeishuHttp(() => f.app.sessions.token(), fakeFetch(() => json({ has_more: true })), 0);
  await expect(tool.invoke(f.app, { appToken: 'app' })).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
});
it('PUT and other mutations are never automatically replayed on provider failures', async () => {
  const f = await fixture(); let calls = 0;
  f.app.api = new FeishuHttp(() => f.app.sessions.token(), fakeFetch(() => { calls++; return json({}, 99991400, 503); }), 0);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const tool = endpoint('test', 'fixture', z.object({}).strict(), [], method, () => ({ path: '/fixture', body: {} }));
    await expect(tool.invoke(f.app, {})).rejects.toMatchObject({ kind: 'RATE_OR_PROVIDER_ERROR' });
  }
  expect(calls).toBe(4);
});
it('serializes writes to the same target and rejects oversized inputs before requests', async () => {
  const f = await fixture(); let active = 0; let maximum = 0;
  f.app.api = new FeishuHttp(() => f.app.sessions.token(), fakeFetch(async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 20)); active--; return json({}); }), 0);
  const tool = endpoint('test', 'fixture', z.object({ text: z.string() }).strict(), [], 'POST', () => ({ path: '/fixture' }));
  await Promise.all([tool.invoke(f.app, { text: 'a' }), tool.invoke(f.app, { text: 'b' })]); expect(maximum).toBe(1);
  await expect(tool.invoke(f.app, { text: 'x'.repeat(100001) })).rejects.toMatchObject({ kind: 'INPUT_TOO_LARGE' });
});
it('validates exact Sheets rectangles and explicit formula opt-in', () => {
  const a = { spreadsheetToken: 'book', sheetId: 'tab', range: 'A1:B1', values: [['hello', 42]] };
  expect(sheetValuesSchema.safeParse(a).success).toBe(true);
  expect(sheetValuesSchema.safeParse({ ...a, values: [[42]] }).success).toBe(false);
  expect(sheetValuesSchema.safeParse({ ...a, values: [['=1+1', 42]] }).success).toBe(false);
  expect(sheetValuesSchema.safeParse({ ...a, values: [['=1+1', 42]], allowFormulas: true }).success).toBe(true);
  for (const range of ['A:A', 'A2:A1', 'A1:ZZ9999', 'tab!A1']) expect(sheetValuesSchema.safeParse({ ...a, range }).success).toBe(false);
});
it('encodes formulas as native objects rather than literal text', async () => {
  const f = await fixture(); const tool = productivityTools.find(t => t.name === 'sheets_write')!;
  await tool.invoke(f.app, { spreadsheetToken: 'book', sheetId: 'tab', range: 'A1:B1', values: [['text', '=1+1']], allowFormulas: true });
  expect(JSON.parse(String(f.requests[0]!.init.body))).toEqual({ valueRange: { range: 'tab!A1:B1', values: [['text', { type: 'formula', text: '=1+1' }]] } });
});
for (const name of ['drive_upload', 'drive_download', 'drive_export_download', 'documents_media_download', 'task_attachments_upload']) {
  it(`${name}: write and scope gates precede local file effects`, async () => {
    const f = await fixture(false); const tool = productivityTools.find(t => t.name === name)!;
    const args = { path: join(f.config.stateDir, 'source'), destination: join(f.config.stateDir, 'target'), fileToken: 'fixture', folderToken: 'fixture', taskId: 'fixture' };
    const schema = z.toJSONSchema(tool.schema) as any;
    const input = Object.fromEntries(Object.keys(schema.properties).map(k => [k, args[k as keyof typeof args]]));
    await expect(tool.invoke(f.app, input)).rejects.toMatchObject({ kind: 'WRITES_DISABLED' });
    f.app.config.writes = true; f.store.value!.scopes = [];
    await expect(tool.invoke(f.app, input)).rejects.toMatchObject({ kind: 'MISSING_SCOPE' }); expect(f.calls()).toBe(0);
    await expect(stat(args.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
}
it('bounds local uploads, rejects symlinks, and exclusively creates bounded downloads', async () => {
  const f = await fixture(); const path = join(f.config.stateDir, 'source.txt'); const dest = join(f.config.stateDir, 'download.txt');
  await writeFile(path, 'hello'); const link = join(f.config.stateDir, 'link'); await symlink(path, link);
  const form = await uploadForm({ path, fields: { parent_type: 'explorer' }, sizeField: true });
  expect(form.get('size')).toBe('5'); expect(form.get('file_name')).toBe('source.txt');
  await expect(uploadForm({ path: link, fields: {} })).rejects.toMatchObject({ kind: 'UNSAFE_FILE' });
  await writeFile(path, Buffer.alloc(5_000_001)); await expect(uploadForm({ path, fields: {} })).rejects.toMatchObject({ kind: 'UNSAFE_FILE' });
  const api = new FeishuHttp(() => f.app.sessions.token(), fakeFetch(() => new Response('hello', { headers: { 'content-disposition': 'attachment' } })), 0);
  expect(await downloadFile(api, '/fixture', dest, [])).toMatchObject({ sizeBytes: 5 });
  expect(await readFile(dest, 'utf8')).toBe('hello'); expect((await stat(dest)).mode & 0o777).toBe(0o600);
  await expect(downloadFile(api, '/fixture', dest, [])).rejects.toMatchObject({ code: 'EEXIST' }); expect(await readFile(dest, 'utf8')).toBe('hello');
});
