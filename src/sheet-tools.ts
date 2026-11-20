import { z } from 'zod';
import { idSchema } from './core.js';
import { cellRangeSchema } from './sheets.js';
import { encode as e, endpoint, shortText, type ProductivityTool } from './productivity.js';
const spreadsheet = { spreadsheetToken: idSchema };
const root = (a: { spreadsheetToken: string }) => `/sheets/v2/spreadsheets/${e(a.spreadsheetToken)}`;
const writeScopes = [['sheets:spreadsheet:write_only', 'sheets:spreadsheet', 'drive:drive']];
const metaScopes = [['sheets:spreadsheet.meta:write_only', 'sheets:spreadsheet', 'drive:drive']];
const tabTitle = z.string().min(1).max(100).regex(/^[^/\\?*\[\]:]+$/);
export const sheetValuesSchema = z.object({ ...spreadsheet, sheetId: idSchema, range: cellRangeSchema,
  values: z.array(z.array(z.union([z.string().max(5000), z.number().finite(), z.boolean(), z.null()])).min(1).max(100)).min(1).max(5000),
  allowFormulas: z.boolean().default(false),
}).strict().superRefine((a, ctx) => {
  if (!cellRangeSchema.safeParse(a.range).success) return;
  const cell = (s: string) => { const [, letters, row] = /^([A-Z]+)([0-9]+)$/.exec(s)!; return { row: Number(row), column: [...letters!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) }; };
  const [first, last = first] = a.range.split(':'); const start = cell(first!); const end = cell(last!);
  if (a.values.length !== end.row - start.row + 1 || a.values.some(r => r.length !== end.column - start.column + 1)) ctx.addIssue({ code: 'custom', message: 'Values must exactly match the rectangular range.' });
  if (!a.allowFormulas && a.values.some(r => r.some(v => typeof v === 'string' && /^\s*=/.test(v)))) ctx.addIssue({ code: 'custom', message: 'Formula strings require allowFormulas=true.' });
});
export const sheetTools: ProductivityTool[] = [
  endpoint('sheets_create', 'Create a spreadsheet using the narrow create grant.', z.object({ title: shortText, folderToken: idSchema.optional() }).strict(), [['sheets:spreadsheet:create', 'sheets:spreadsheet', 'drive:drive']], 'POST', a => ({ path: '/sheets/v3/spreadsheets', body: { title: a.title, folder_token: a.folderToken }, lock: 'sheets-create' })),
  endpoint('sheets_write', 'Overwrite one explicit rectangular range (at most 10000 cells, 100 columns, 100 KB request). Formula strings require allowFormulas and are encoded as native formula objects. Legacy API may reject narrow grants; no permission escalation.', sheetValuesSchema, writeScopes, 'PUT', a => ({ path: `${root(a)}/values`, body: { valueRange: { range: `${a.sheetId}!${a.range}`, values: a.values.map(row => row.map(value => a.allowFormulas && typeof value === 'string' && /^\s*=/.test(value) ? { type: 'formula', text: value.trimStart() } : value)) } }, lock: root(a) })),
  endpoint('sheets_rename', 'Rename a spreadsheet. Legacy API may require broader grants than the reviewed permission pack.', z.object({ ...spreadsheet, title: shortText }).strict(), metaScopes, 'PATCH', a => ({ path: `/sheets/v3/spreadsheets/${e(a.spreadsheetToken)}`, body: { title: a.title }, lock: root(a) })),
  endpoint('sheets_tabs_create', 'Create a named tab. Legacy API may reject narrow grants.', z.object({ ...spreadsheet, title: tabTitle }).strict(), metaScopes, 'POST', a => ({ path: `${root(a)}/sheets_batch_update`, body: { requests: [{ addSheet: { properties: { title: a.title } } }] }, lock: root(a) })),
  endpoint('sheets_tabs_update', 'Update tab title, position, visibility or frozen rows/columns; never changes protection or sharing.', z.object({ ...spreadsheet, sheetId: idSchema, title: tabTitle.optional(), index: z.number().int().min(0).max(1000).optional(), hidden: z.boolean().optional(), frozenRowCount: z.number().int().min(0).max(100000).optional(), frozenColCount: z.number().int().min(0).max(1000).optional() }).strict(), metaScopes, 'POST', a => ({ path: `${root(a)}/sheets_batch_update`, query: { user_id_type: 'open_id' }, body: { requests: [{ updateSheet: { properties: { sheetId: a.sheetId, title: a.title, index: a.index, hidden: a.hidden, frozenRowCount: a.frozenRowCount, frozenColCount: a.frozenColCount } } }] }, lock: root(a) })),
  endpoint('sheets_tabs_delete', 'Delete one explicit tab and all its cells. Destructive; legacy API may reject narrow grants.', z.object({ ...spreadsheet, sheetId: idSchema }).strict(), metaScopes, 'POST', a => ({ path: `${root(a)}/sheets_batch_update`, body: { requests: [{ deleteSheet: { sheetId: a.sheetId } }] }, lock: root(a) })),
];
