// Explicit live integration validation. Mutations target only resources this run creates.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { settings, safeError } from '../dist/core.js';
import { KeychainStore } from '../dist/credentials.js';
import { runtime } from '../dist/server.js';
import { productivityTools } from '../dist/productivity-tools.js';
import { z } from 'zod';
assert.equal(process.argv[2], '--live-disposable', 'Pass --live-disposable to authorize disposable-resource tests.');
const config = settings({ ...process.env, BETTER_FEISHU_MCP_ENABLE_WRITES: '1' });
const app = runtime(config, new KeychainStore(config.profile));
const checks = []; const resources = []; const cleanup = [];
async function check(name, args, verify = () => {}) {
  try {
    const tool = productivityTools.find(t => t.name === name); assert.ok(tool);
    const data = await tool.invoke(app, args); verify(data);
    checks.push({ name, status: 'passed' }); return data;
  } catch (error) { checks.push({ name, status: 'failed', error: safeError(error) }); return undefined; }
}
const title = 'mcp-disposable-productivity-' + Date.now();
try {
  for (const [name, args] of [['wiki_spaces_list', {}], ['calendars_list', {}], ['tasks_list', {}], ['tasklists_list', {}]]) await check(name, args);
  const user = await app.sessions.token();
  await check('calendar_freebusy', { userId: user.userId, timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 3600000).toISOString() });
  const doc = await app.operations.execute({ type: 'create', title, content: [{ type: 'paragraph', text: 'Disposable productivity validation.' }] });
  resources.push({ type: 'docx', token: doc.documentId });
  cleanup.push(async () => { const meta = await app.documents.metadata(doc.documentId); await app.documents.delete(doc.documentId, meta.revision_id); });
  const file = { fileToken: doc.documentId, fileType: 'docx' };
  const meta = await app.documents.metadata(doc.documentId);
  const board = await app.boards.add({ documentId: doc.documentId, revision: meta.revision_id, mermaid: 'flowchart LR\nA[Disposable] --> B[Validation]' });
  const nodes = await app.boards.nodes({ boardId: board.boardId });
  if (nodes.nodes.length) {
    await check('boards_delete_nodes', { boardId: board.boardId, nodeIds: nodes.nodes.map(n => n.id) });
    const after = await app.boards.nodes({ boardId: board.boardId }); assert.equal(after.nodes.length, 0); checks.push({ name: 'boards_delete_readback', status: 'passed' });
  }
  await check('drive_metadata', { files: [{ fileToken: doc.documentId, type: 'docx' }] });
  const root = await check('drive_root', {});
  if (root?.token) {
    const folder = await check('drive_folders_create', { name: title, folderToken: root.token });
    if (folder?.token) {
      const folderToken = folder.token;
      resources.push({ type: 'folder', token: folderToken });
      cleanup.push(() => app.api.request('DELETE', `/drive/v1/files/${encodeURIComponent(folderToken)}?type=folder`, z.unknown(), { scopes: [['space:document:delete', 'drive:drive']] }));
      const child = await check('drive_folders_create', { name: 'mcp-child', folderToken });
      const copied = await check('drive_copy', { fileToken: doc.documentId, type: 'docx', name: title + '-copy', folderToken });
      if (copied?.file?.token && child?.token) await check('drive_move', { fileToken: copied.file.token, type: 'docx', folderToken: child.token });
      await check('drive_shortcut', { fileToken: doc.documentId, type: 'docx', folderToken });
      await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
      const path = config.stateDir + '/' + title + '.txt'; await writeFile(path, title, { flag: 'wx', mode: 0o600 });
      const uploaded = await check('drive_upload', { path, folderToken });
      if (uploaded?.file_token) {
        await check('drive_download', { fileToken: uploaded.file_token, destination: path + '.download' }, d => assert.equal(d.sizeBytes, Buffer.byteLength(title)));
        const imported = await check('drive_import_create', { fileToken: uploaded.file_token, fileExtension: 'txt', type: 'docx', folderToken });
        if (imported?.ticket) {
          let done = false;
          for (let i = 0; i < 8; i++) {
            const status = await check('drive_import_get', { ticket: imported.ticket }); const result = status?.result;
            if (result?.job_status === 0 && result.token) {
              const read = await app.documents.text(result.token); assert.ok(read.text.includes(title)); checks.push({ name: 'drive_import_readback', status: 'passed' }); done = true; break;
            }
            if (result && result.job_status !== 1 && result.job_status !== 2) break;
            await new Promise(r => setTimeout(r, 1000));
          }
          if (!done) checks.push({ name: 'drive_import_completion', status: 'unverified' });
        }
      }
    }
  }
  const exported = await check('drive_export_create', { token: doc.documentId, type: 'docx', fileExtension: 'docx' });
  if (exported?.ticket) {
    for (let i = 0; i < 8; i++) {
      const status = await check('drive_export_get', { ticket: exported.ticket, token: doc.documentId });
      const result = status?.result;
      if (result?.job_status === 0 && result.file_token) {
        const destination = config.stateDir + '/' + title + '.docx';
        await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
        await check('drive_export_download', { fileToken: result.file_token, destination }, d => assert.ok(d.sizeBytes > 0));
        break;
      }
      if (result && result.job_status !== 1 && result.job_status !== 2) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  const comment = await check('comments_create', { ...file, text: title });
  await check('comments_list', file);
  const commentId = comment?.comment_id ?? comment?.comment?.comment_id;
  if (commentId) {
    const reply = await check('comments_reply', { ...file, commentId, text: title + ' verification reply' });
    const replyId = reply?.reply_id ?? reply?.reply?.reply_id;
    if (replyId) { await check('comments_reply_update', { ...file, commentId, replyId, text: 'Updated disposable reply' }); await check('comments_reply_delete', { ...file, commentId, replyId }); }
    await check('comments_resolve', { ...file, commentId, isSolved: true });
  }
  const calendar = await check('calendars_create', { summary: title });
  const calendarId = calendar?.calendar?.calendar_id;
  if (calendarId) {
    resources.push({ type: 'calendar', token: calendarId }); cleanup.push(async () => { const d = await check('calendars_delete', { calendarId }); if (!d) throw new Error('Calendar cleanup failed'); });
    await check('calendars_get', { calendarId }); await check('calendars_update', { calendarId, summary: title + '-updated' });
    const start = Math.floor(Date.now() / 1000) + 3600; const end = start + 1800;
    const times = { start_time: { timestamp: String(start), timezone: 'UTC' }, end_time: { timestamp: String(end), timezone: 'UTC' } };
    const event = await check('calendar_events_create', { calendarId, summary: title, ...times });
    const eventId = event?.event?.event_id;
    await check('calendar_events_list', { calendarId, anchorTime: String(start - 60) });
    if (eventId) { await check('calendar_events_get', { calendarId, eventId }); await check('calendar_events_update', { calendarId, eventId, summary: title + '-updated', ...times }); await check('calendar_events_delete', { calendarId, eventId }); }
  }
  const base = await check('base_create', { name: title }); const appToken = base?.app?.app_token;
  if (appToken) {
    resources.push({ type: 'bitable', token: appToken }); cleanup.push(() => app.api.request('DELETE', `/drive/v1/files/${encodeURIComponent(appToken)}?type=bitable`, z.unknown(), { scopes: [['space:document:delete', 'drive:drive']] }));
    await check('base_get', { appToken }); await check('base_tables_list', { appToken });
    const table = await check('base_tables_create', { appToken, name: title }); const tableId = table?.table_id ?? table?.table?.table_id;
    if (tableId) {
      const target = { appToken, tableId }; await check('base_tables_update', { ...target, name: title + '-updated' }); await check('base_views_list', target);
      const field = await check('base_fields_create', { ...target, field: { field_name: 'mcp-value', type: 1 } }); const fieldId = field?.field?.field_id;
      await check('base_fields_list', target);
      const record = await check('base_records_create', { ...target, fields: { 'mcp-value': title } }); const recordId = record?.record?.record_id;
      const found = await check('base_records_search', target); if (found && recordId) assert.ok(found.items?.some(r => r.record_id === recordId));
      if (recordId) { await check('base_records_get', { ...target, recordId }); await check('base_records_update', { ...target, recordId, fields: { 'mcp-value': 'updated' } }); await check('base_records_delete', { ...target, recordId }); }
      if (fieldId) { await check('base_fields_update', { ...target, fieldId, field: { field_name: 'mcp-updated', type: 1 } }); await check('base_fields_delete', { ...target, fieldId }); }
      await check('base_tables_delete', target);
    }
  }
  const sheet = await check('sheets_create', { title }); const spreadsheetToken = sheet?.spreadsheet?.spreadsheet_token;
  if (spreadsheetToken) {
    resources.push({ type: 'sheet', token: spreadsheetToken }); cleanup.push(() => app.api.request('DELETE', `/drive/v1/files/${encodeURIComponent(spreadsheetToken)}?type=sheet`, z.unknown(), { scopes: [['space:document:delete', 'drive:drive']] }));
    try {
      await app.sheets.metadata(spreadsheetToken); checks.push({ name: 'sheets_get', status: 'passed' });
      const tabs = await app.sheets.tabs(spreadsheetToken); checks.push({ name: 'sheets_list', status: 'passed' }); const sheetId = tabs.sheets[0]?.sheet_id;
      if (sheetId) { await check('sheets_write', { spreadsheetToken, sheetId, range: 'A1:B1', values: [['fixture', '=1+1']], allowFormulas: true }); const data = await app.sheets.read(spreadsheetToken, sheetId, 'A1:B1'); assert.equal(Number(data.valueRange.values[0]?.[1]), 2); checks.push({ name: 'sheets_read_formula_result', status: 'passed' }); }
    } catch (error) { checks.push({ name: 'sheets_list/read', status: 'failed', error: safeError(error) }); }
    await check('sheets_rename', { spreadsheetToken, title: title + '-updated' });
    const tab = await check('sheets_tabs_create', { spreadsheetToken, title: 'mcp-disposable-tab' }); const sheetId = tab?.replies?.[0]?.addSheet?.properties?.sheetId;
    if (sheetId) { await check('sheets_tabs_update', { spreadsheetToken, sheetId, title: 'mcp-updated-tab' }); await check('sheets_tabs_delete', { spreadsheetToken, sheetId }); }
  }
} catch (error) { checks.push({ name: 'runner', status: 'failed', error: safeError(error) }); }
finally {
  for (const run of cleanup.reverse()) { try { await run(); checks.push({ name: 'cleanup', status: 'passed' }); } catch (error) { checks.push({ name: 'cleanup', status: 'failed', error: safeError(error) }); } }
  const report = { date: new Date().toISOString(), resources, checks, note: 'No mutations to pre-existing team resources. Unlisted operations are not live-validated.' };
  await mkdir(new URL('../.runtime/', import.meta.url), { recursive: true, mode: 0o700 });
  await writeFile(new URL('../.runtime/productivity-live.json', import.meta.url), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (checks.some(c => c.status === 'failed')) process.exitCode = 1;
}
