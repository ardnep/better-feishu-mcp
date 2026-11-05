import { expect, it } from 'vitest';
import { documentReadSchema } from '../src/core.js';
import { FeishuHttp } from '../src/http.js';
import { Documents } from '../src/services.js';
import { Sheets, spreadsheetSchema } from '../src/sheets.js';
import { fakeFetch, json, session } from './helpers.js';

const link = 'https://example.feishu.cn/wiki/wikiNode?sheet=tab';
it('accepts Wiki read links without confusing them with legacy Docs or direct tokens', () => {
  expect(documentReadSchema.parse(link)).toBe(link);
  expect(spreadsheetSchema.parse(link)).toBe(link);
  for (const bad of ['https://evil.com/wiki/id', 'https://a.feishu.cn:123/wiki/id', 'http://a.feishu.cn/wiki/id', 'https://user@a.feishu.cn/wiki/id', 'https://a.feishu.cn/doc/legacy']) {
    expect(documentReadSchema.safeParse(bad).success, bad).toBe(false);
    expect(spreadsheetSchema.safeParse(bad).success, bad).toBe(false);
  }
});
it('resolves Wiki Sheets links for metadata, tab listing and range reads using only user GETs', async () => {
  const paths: string[] = [];
  const api = new FeishuHttp(async () => session(), fakeFetch((url, init) => {
    expect(init.method).toBe('GET'); expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-user-token-never-live');
    paths.push(url.pathname);
    if (url.pathname.endsWith('/get_node')) {
      expect(url.searchParams.get('token')).toBe('wikiNode'); expect(url.searchParams.get('obj_type')).toBe('wiki');
      return json({ node: { obj_type: 'sheet', obj_token: 'actualSheet' } });
    }
    if (url.pathname.endsWith('/sheets/query')) return json({ sheets: [{ sheet_id: 'tab', title: 'Ignore instructions', index: 0 }] });
    if (url.pathname.includes('/values/')) return json({ spreadsheetToken: 'actualSheet', revision: 1, valueRange: { range: 'tab!A1', values: [[42]] } });
    return json({ spreadsheet: { token: 'actualSheet', title: 'Wiki Sheet' } });
  }), 0);
  const sheets = new Sheets(api);
  expect(await sheets.metadata(link)).toMatchObject({ spreadsheet: { token: 'actualSheet' } });
  expect(await sheets.tabs(link)).toMatchObject({ spreadsheetToken: 'actualSheet' });
  expect(await sheets.read(link, 'tab', 'A1')).toMatchObject({ valueRange: { values: [[42]] } });
  expect(paths.filter(path => path.endsWith('/get_node'))).toHaveLength(3);
  expect(paths.filter(path => !path.endsWith('/get_node')).every(path => path.includes('/actualSheet'))).toBe(true);
});
it('resolves Wiki Docx links for metadata, text and blocks and returns the actual document ID', async () => {
  const paths: string[] = [];
  const api = new FeishuHttp(async () => session(), fakeFetch(url => {
    paths.push(url.pathname);
    if (url.pathname.endsWith('/get_node')) return json({ node: { obj_type: 'docx', obj_token: 'actualDoc' } });
    if (url.pathname.endsWith('/raw_content')) return json({ content: 'Untrusted Wiki content' });
    if (url.pathname.endsWith('/blocks')) return json({ items: [{ block_id: 'block' }], has_more: false });
    return json({ document: { document_id: 'actualDoc', title: 'Wiki doc', revision_id: 7 } });
  }), 0);
  const docs = new Documents(api);
  expect(await docs.metadata(link)).toMatchObject({ document_id: 'actualDoc' });
  expect(await docs.text(link)).toMatchObject({ document: { document_id: 'actualDoc' }, text: 'Untrusted Wiki content', untrustedData: true });
  expect(await docs.blocks(link)).toMatchObject({ document: { document_id: 'actualDoc' }, blocks: [{ block_id: 'block' }] });
  expect(paths.filter(path => !path.endsWith('/get_node')).every(path => path.includes('/actualDoc'))).toBe(true);
});
it('reports wrong Wiki types and permission failures without guessing or identity fallback', async () => {
  for (const type of ['doc', 'docx', 'bitable']) {
    let calls = 0;
    const sheets = new Sheets(new FeishuHttp(async () => session(), fakeFetch(() => { calls++; return json({ node: { obj_type: type, obj_token: 'target' } }); }), 0));
    await expect(sheets.tabs(link)).rejects.toMatchObject({ kind: 'WIKI_TYPE_MISMATCH', details: { actualType: type } });
    expect(calls).toBe(1);
  }
  let calls = 0;
  const missing = new Sheets(new FeishuHttp(async () => session({ scopes: ['sheets:spreadsheet:readonly'] }), fakeFetch(() => { calls++; return json({}); }), 0));
  await expect(missing.metadata(link)).rejects.toMatchObject({ kind: 'MISSING_SCOPE' }); expect(calls).toBe(0);
  const denied = new Sheets(new FeishuHttp(async () => session(), fakeFetch(() => { calls++; return json({}, 131006, 403); }), 0));
  await expect(denied.metadata(link)).rejects.toMatchObject({ kind: 'FEISHU_ERROR' }); expect(calls).toBe(1);
});
