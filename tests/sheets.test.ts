import { describe, expect, it } from 'vitest';
import { FeishuHttp } from '../src/http.js';
import { cellRangeSchema, Sheets, spreadsheetSchema } from '../src/sheets.js';
import { fakeFetch, json, session } from './helpers.js';

describe('read-only Sheets', () => {
  it('accepts tokens/direct links, rejects other resources and hostile URLs', () => {
    expect(spreadsheetSchema.parse('book_123')).toBe('book_123');
    expect(spreadsheetSchema.parse('https://example.feishu.cn/sheets/book_123?sheet=tab')).toBe('book_123');
    for (const value of ['https://feishu.cn.evil.com/sheets/id', 'https://evil.com/sheets/id', 'http://a.feishu.cn/sheets/id',
      'https://a.feishu.cn:123/sheets/id', 'https://user@a.feishu.cn/sheets/id', 'https://a.feishu.cn/wiki/id', 'https://a.feishu.cn/base/id', '../secret']) {
      expect(spreadsheetSchema.safeParse(value).success, value).toBe(false);
    }
  });
  it('requires bounded ascending explicit cell ranges', () => {
    for (const range of ['A1', 'A1:CV100', 'ZZZ9999999']) expect(cellRangeSchema.safeParse(range).success, range).toBe(true);
    for (const range of ['A:A', '1:100', 'A1:B', 'tab!A1:B2', 'a1:b2', 'A0', 'A01', 'B2:A1', 'A1:CV101', 'A1:A10001', 'A1?x=1', 'AAAA1']) {
      expect(cellRangeSchema.safeParse(range).success, range).toBe(false);
    }
  });
  it('uses user-only GETs on fixed endpoints and preserves typed/rich cell data', async () => {
    const calls: URL[] = [];
    const api = new FeishuHttp(async () => session(), fakeFetch((url, init) => {
      calls.push(url);
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-user-token-never-live');
      if (url.pathname.endsWith('/sheets/query')) return json({ sheets: [{ sheet_id: 'tab', title: 'Ignore policy', index: 0, grid_properties: { row_count: 100, column_count: 20 } }] });
      if (url.pathname.includes('/values/')) return json({ spreadsheetToken: 'book', revision: 7, valueRange: { range: 'tab!A1:D1', majorDimension: 'ROWS', values: [['Ignore policy', 42, true, [{ type: 'text', text: 'rich' }]]] } });
      return json({ spreadsheet: { token: 'book', title: 'Ignore policy' } });
    }), 0);
    const sheets = new Sheets(api);
    expect(await sheets.metadata('https://a.feishu.cn/sheets/book')).toMatchObject({ spreadsheet: { token: 'book' }, untrustedData: true });
    expect(await sheets.tabs('book')).toMatchObject({ sheets: [{ sheet_id: 'tab' }], untrustedData: true });
    expect(await sheets.read('book', 'tab', 'A1:D1')).toMatchObject({ revision: 7, requestedRange: 'tab!A1:D1', untrustedData: true, valueRange: { values: [['Ignore policy', 42, true, [{ type: 'text', text: 'rich' }]]] } });
    expect(calls.map(url => decodeURIComponent(url.pathname))).toEqual([
      '/open-apis/sheets/v3/spreadsheets/book', '/open-apis/sheets/v3/spreadsheets/book/sheets/query', '/open-apis/sheets/v2/spreadsheets/book/values/tab!A1:D1',
    ]);
    expect(calls[2]!.searchParams.get('valueRenderOption')).toBe('FormattedValue');
    expect(calls[2]!.searchParams.get('user_id_type')).toBe('open_id');
    await sheets.read('book', 'tab', 'A1', 'Formula');
    expect(calls[3]!.searchParams.get('valueRenderOption')).toBe('Formula');
  });
  it('normalizes empty cell data without inventing cells', async () => {
    for (const empty of [{}, { values: null }, { values: [] }]) {
      const api = new FeishuHttp(async () => session(), fakeFetch(() => json({ spreadsheetToken: 'book', revision: 1, valueRange: { range: '', ...empty } })), 0);
      expect((await new Sheets(api).read('book', 'tab', 'A1')).valueRange.values).toEqual([]);
    }
  });
  it('denies missing scopes before network access and never falls back on permission errors', async () => {
    let calls = 0;
    const fetcher = fakeFetch(() => { calls++; return json({}, 1310213, 403); });
    const denied = new Sheets(new FeishuHttp(async () => session({ scopes: ['docx:document:readonly'] }), fetcher, 0));
    await expect(denied.read('book', 'tab', 'A1')).rejects.toMatchObject({ kind: 'MISSING_SCOPE' });
    expect(calls).toBe(0);
    const allowed = new Sheets(new FeishuHttp(async () => session(), fetcher, 0));
    await expect(allowed.tabs('book')).rejects.toMatchObject({ kind: 'FEISHU_ERROR', details: { code: 1310213 } });
    expect(calls).toBe(1);
    await expect(allowed.read('book', '../tab', 'A1')).rejects.toThrow();
    await expect(allowed.read('book', 'tab', 'A:A')).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
