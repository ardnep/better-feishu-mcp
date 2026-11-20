// Controlled real API validation: disposable resources and the predesignated
// sole-user fixture chat only. Never discover a third-party recipient to test on.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { settings, safeError } from '../dist/core.js';
import { KeychainStore } from '../dist/credentials.js';
import { runtime } from '../dist/server.js';
import { productivityTools } from '../dist/productivity-tools.js';
assert.equal(process.argv[2], '--live-disposable');
const config = settings({ ...process.env, BETTER_FEISHU_MCP_ENABLE_WRITES: '1' });
const app = runtime(config, new KeychainStore(config.profile));
const checks = []; const cleanup = []; const retained = [];
const name = 'mcp-core-disposable-' + Date.now();
async function check(name, args, verify = () => {}) {
  try {
    const tool = productivityTools.find(t => t.name === name); assert.ok(tool);
    const data = await tool.invoke(app, args); verify(data);
    checks.push({ name, status: 'passed' }); return data;
  } catch (error) { checks.push({ name, status: 'failed', error: safeError(error) }); return undefined; }
}
function disposable(type, token) {
  cleanup.push(async () => app.api.request('DELETE', `/drive/v1/files/${encodeURIComponent(token)}?type=${type}`, z.unknown(), { scopes: ['space:document:delete'] }));
}
try {
  const user = await app.sessions.token();
  await check('people_get', { userId: user.userId }, d => assert.equal(d.user?.open_id, user.userId));
  await check('chats_search', { query: 'better-feishu-mcp', limit: 20 });
  const root = await check('drive_root', {});
  if (root?.token) await check('drive_files_list', { folderToken: root.token, limit: 5 });
  await check('documents_search', { query: 'mcp', docFilter: { only_title: true }, wikiFilter: { only_title: true }, limit: 5 });
  const doc = await app.operations.execute({ type: 'create', title: name, content: [{ type: 'paragraph', text: 'Disposable core API validation.' }] });
  disposable('docx', doc.documentId);
  await check('sharing_members_list', { token: doc.documentId, type: 'docx' });
  const base = await check('base_create', { name });
  const appToken = base?.app?.app_token;
  if (appToken) {
    disposable('bitable', appToken);
    await check('base_update', { appToken, name: name + '-updated' });
    const tables = await check('base_tables_list', { appToken });
    const tableId = tables?.items?.[0]?.table_id;
    if (tableId) {
      const view = await check('base_views_create', { appToken, tableId, name: 'Disposable view' });
      const viewId = view?.view?.view_id;
      if (viewId) {
        await check('base_views_update', { appToken, tableId, viewId, name: 'Updated view', hiddenFields: [] });
        await check('base_views_delete', { appToken, tableId, viewId });
      }
    }
  }
  const calendar = await check('calendars_create', { summary: name });
  const calendarId = calendar?.calendar?.calendar_id;
  if (calendarId) {
    cleanup.push(() => productivityTools.find(t => t.name === 'calendars_delete').invoke(app, { calendarId }));
    const start = Math.floor(Date.now() / 1000) + 86400;
    const created = await check('calendar_events_create', { calendarId, summary: name, start_time: { timestamp: String(start) }, end_time: { timestamp: String(start + 1800) } });
    const eventId = created?.event?.event_id;
    if (eventId) {
      await check('calendar_attendees_add', { calendarId, eventId, userIds: [user.userId], notify: false });
      const attendees = await check('calendar_attendees_list', { calendarId, eventId });
      const accessible = await check('calendars_list', {});
      const primary = accessible?.calendar_list?.find(c => c.type === 'primary' && c.role === 'owner');
      if (primary) await check('calendar_events_reply', { calendarId: primary.calendar_id, eventId, status: 'accept' });
      const attendeeIds = attendees?.items?.filter(a => a.user_id === user.userId).map(a => a.attendee_id);
      if (attendeeIds?.length) await check('calendar_attendees_delete', { calendarId, eventId, attendeeIds, notify: false });
    }
  }
  const list = await check('tasklists_create', { name });
  if (list?.tasklist?.guid) {
    const tasklistId = list.tasklist.guid;
    cleanup.push(() => productivityTools.find(t => t.name === 'tasklists_delete').invoke(app, { tasklistId }));
    await check('tasklists_update', { tasklistId, name: name + '-updated' });
    await check('tasklists_tasks', { tasklistId });
  }
  // Full task delete is deliberately deferred. Keep at most one completed,
  // explicitly labelled test task, recording its ID for manual cleanup.
  const task = await check('tasks_create', { summary: name, clientToken: randomUUID() });
  if (task?.task?.guid) {
    const taskId = task.task.guid; retained.push({ type: 'completed-test-task', taskId, reason: 'task:task:write deferred; narrow scope cannot delete' });
    cleanup.push(() => productivityTools.find(t => t.name === 'tasks_update').invoke(app, { taskId, changes: { completed_at: String(Date.now()) } }));
    await check('tasks_update', { taskId, changes: { summary: name + '-updated', due: { timestamp: String(Date.now() + 86400000) }, completed_at: String(Date.now()) } });
    await check('tasks_get', { taskId }, d => assert.equal(d.task?.summary, name + '-updated'));
    await check('tasks_update', { taskId, changes: { completed_at: '0' } });
  }
  const groups = await app.messages.groups(50);
  const chat = groups.items.find(c => c.name === 'better-feishu-mcp API test (temporary)');
  if (chat?.chat_id) {
    const chatId = chat.chat_id;
    await check('chats_get', { chatId });
    const members = await check('chats_members', { chatId, limit: 50 });
    assert.equal(members?.hasMore, false); assert.equal(members?.items?.length, 1);
    assert.equal(members.items[0].member_id, user.userId, 'Only the authorized user may be in this fixture');
    const recipient = { type: 'chat_id', id: chatId };
    async function sent(toolName, args) {
      const data = await check(toolName, { ...args, uuid: randomUUID() });
      if (data?.message_id) cleanup.push(() => productivityTools.find(t => t.name === 'messages_recall').invoke(app, { messageId: data.message_id, visibility: 'group' }));
      return data;
    }
    const text = await sent('messages_send', { recipient, content: { type: 'text', text: name } });
    if (text?.message_id) {
      const read = await app.messages.get(text.message_id, 'group'); assert.equal(read.items[0]?.sender?.id, user.userId);
      checks.push({ name: 'messages_send_user_identity_readback', status: 'passed' });
      await sent('messages_reply', { messageId: text.message_id, content: { type: 'text', text: name + '-reply' }, replyInThread: true });
    }
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const path = join(config.stateDir, name + '.txt'); await writeFile(path, name, { flag: 'wx', mode: 0o600 });
    const uploaded = await check('messages_upload_file', { path, fileName: name + '.txt' });
    if (uploaded?.file_key) { retained.push({ type: 'uploaded-im-file', reason: 'No verified IM upload-delete API' }); await sent('messages_send', { recipient, content: { type: 'file', fileKey: uploaded.file_key } }); }
    const imagePath = join(config.stateDir, name + '.png');
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=', 'base64'), { flag: 'wx', mode: 0o600 });
    const image = await check('messages_upload_image', { path: imagePath });
    if (image?.image_key) { retained.push({ type: 'uploaded-im-image', reason: 'No verified IM upload-delete API' }); await sent('messages_send', { recipient, content: { type: 'image', imageKey: image.image_key } }); }
  } else checks.push({ name: 'messaging-fixture', status: 'unverified', reason: 'Designated sole-user fixture absent from bounded group page' });
} catch (error) { checks.push({ name: 'runner', status: 'failed', error: safeError(error) }); }
finally {
  for (const [i, fn] of cleanup.reverse().entries()) {
    try { await fn(); checks.push({ name: `cleanup-${i}`, status: 'passed' }); }
    catch (error) { checks.push({ name: `cleanup-${i}`, status: 'failed', error: safeError(error) }); }
  }
}
console.log(JSON.stringify({ checks, retained }, null, 2));
if (checks.some(c => c.status === 'failed')) process.exitCode = 1;
