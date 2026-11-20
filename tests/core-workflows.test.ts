import { afterEach, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { productivityTools } from '../src/productivity-tools.js';
import { extractAttachment } from '../dist/attachments.js';
import { runtime } from '../src/server.js';
import { fakeFetch, json, MemoryStore, session, setup } from './helpers.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tool = (name: string) => productivityTools.find(t => t.name === name)!;
async function fixture(response: Record<string, unknown> = {}) {
  const env = await setup(true); cleanups.push(env.cleanup);
  const store = new MemoryStore(session({ scopes: [...new Set([...session().scopes, ...productivityTools.flatMap(t => t.scopes.flatMap(s => typeof s === 'string' ? [s] : [...s]))])], userId: 'ou_fixture' }));
  const requests: { url: URL; init: RequestInit }[] = [];
  const app = runtime(env.config, store, fakeFetch((url, init) => { requests.push({ url, init }); return json(response); }));
  return { ...env, store, app, requests };
}
function body(request: { init: RequestInit }) { return JSON.parse(String(request.init.body)); }
it('sends exactly serialized native content with explicit user scope and deduplication key', async () => {
  const f = await fixture();
  const args = { recipient: { type: 'open_id', id: 'ou_recipient' }, content: { type: 'text', text: 'hello\n"quoted"' }, uuid: 'delivery-1' };
  await tool('messages_send').invoke(f.app, args);
  expect(f.requests[0]!.url.searchParams.get('receive_id_type')).toBe('open_id');
  expect(body(f.requests[0]!)).toEqual({ receive_id: 'ou_recipient', msg_type: 'text', content: JSON.stringify({ text: args.content.text }), uuid: 'delivery-1' });
  f.store.value!.scopes = ['im:message'];
  await expect(tool('messages_send').invoke(f.app, args)).rejects.toMatchObject({ kind: 'MISSING_SCOPE' });
  expect(f.requests).toHaveLength(1);
  for (const bad of [{ ...args, uuid: undefined }, { ...args, recipient: { type: 'chat_id', id: 'cli_bot' } }, { ...args, content: { type: 'file', fileKey: 'key', text: 'hidden' } }]) expect(tool('messages_send').schema.safeParse(bad).success).toBe(false);
});
it('reply keeps thread choice and native file key distinct from content fields', async () => {
  const f = await fixture();
  await tool('messages_reply').invoke(f.app, { messageId: 'om_fixture', content: { type: 'file', fileKey: 'file_native' }, uuid: 'reply-1', replyInThread: true });
  expect(body(f.requests[0]!)).toEqual({ msg_type: 'file', content: '{"file_key":"file_native"}', uuid: 'reply-1', reply_in_thread: true });
});
it('recall verifies ownership and never deletes a bot/other-user/ambiguous message', async () => {
  for (const sender of [{ id: 'ou_other', id_type: 'open_id', sender_type: 'user' }, { id: 'ou_fixture', id_type: 'user_id', sender_type: 'user' }, { id: 'ou_fixture', id_type: 'open_id', sender_type: 'app' }]) {
    const f = await fixture({ items: [{ message_id: 'om_fixture', sender }] });
    await expect(tool('messages_recall').invoke(f.app, { messageId: 'om_fixture', visibility: 'group' })).rejects.toMatchObject({ kind: 'NOT_MESSAGE_OWNER' });
    expect(f.requests.map(r => r.init.method)).toEqual(['GET']);
  }
  const f = await fixture({ items: [{ message_id: 'om_fixture', sender: { id: 'ou_fixture', id_type: 'open_id', sender_type: 'user' } }] });
  await tool('messages_recall').invoke(f.app, { messageId: 'om_fixture', visibility: 'p2p' });
  expect(f.requests.map(r => r.init.method)).toEqual(['GET', 'DELETE']);
  f.app.config.writes = false;
  await expect(tool('messages_recall').invoke(f.app, { messageId: 'om_fixture', visibility: 'p2p' })).rejects.toMatchObject({ kind: 'WRITES_DISABLED' });
  expect(f.requests).toHaveLength(2);
});
it('document search paginates in the body and binds cursors to filters and identity', async () => {
  const f = await fixture({ has_more: true, page_token: 'private-token', res_units: [] });
  const args = { query: 'fixture', docFilter: { only_title: true }, limit: 5 };
  const first = await tool('documents_search').invoke(f.app, args) as { nextCursor: string };
  await tool('documents_search').invoke(f.app, { ...args, cursor: first.nextCursor });
  expect(f.requests[1]!.url.search).toBe('');
  expect(body(f.requests[1]!)).toEqual({ query: 'fixture', doc_filter: { only_title: true }, page_size: 5, page_token: 'private-token' });
  await expect(tool('documents_search').invoke(f.app, { ...args, docFilter: {}, cursor: first.nextCursor })).rejects.toMatchObject({ kind: 'INVALID_CURSOR' });
  expect(tool('documents_search').schema.safeParse({ query: 'fixture' }).success).toBe(false);
  expect(tool('drive_files_list').schema.safeParse({}).success).toBe(false);
});
it('native uploads use the right multipart image/file fields and retain local upload safeguards', async () => {
  const f = await fixture(); const path = join(f.config.stateDir, 'native.txt'); await writeFile(path, 'fixture');
  await tool('messages_upload_image').invoke(f.app, { path });
  const image = f.requests[0]!.init.body as FormData;
  expect(image.get('image_type')).toBe('message'); expect(image.get('image')).toBeInstanceOf(Blob); expect(image.has('file')).toBe(false);
  await tool('messages_upload_file').invoke(f.app, { path, fileName: 'native.txt' });
  const file = f.requests[1]!.init.body as FormData;
  expect(file.get('file_name')).toBe('native.txt'); expect(file.get('file_type')).toBe('stream'); expect(file.get('file')).toBeInstanceOf(Blob);
  f.store.value!.scopes = [];
  await expect(tool('messages_upload_file').invoke(f.app, { path, fileName: 'native.txt' })).rejects.toMatchObject({ kind: 'MISSING_SCOPE' });
  expect(f.requests).toHaveLength(2);
});
it('targeted sharing encodes explicit user roles without owner/public-setting changes', async () => {
  const f = await fixture();
  await tool('sharing_members_add').invoke(f.app, { token: 'doc', type: 'docx', userId: 'ou_recipient', permission: 'view' });
  expect(body(f.requests[0]!)).toEqual({ member_type: 'openid', member_id: 'ou_recipient', type: 'user', perm: 'view' });
  expect(f.requests[0]!.url.searchParams.get('need_notification')).toBe('false');
  expect(tool('sharing_members_add').schema.safeParse({ token: 'doc', type: 'docx', userId: 'ou_recipient', permission: 'owner' }).success).toBe(false);
});
it('task updates only touch named fields and preserve explicit completion/reopen timestamps', async () => {
  const f = await fixture();
  for (const completed_at of ['1795160000000', '0']) await tool('tasks_update').invoke(f.app, { taskId: 'task', changes: { completed_at } });
  expect(body(f.requests[0]!)).toEqual({ task: { completed_at: '1795160000000' }, update_fields: ['completed_at'] });
  expect(body(f.requests[1]!)).toEqual({ task: { completed_at: '0' }, update_fields: ['completed_at'] });
  expect(tool('tasks_update').schema.safeParse({ taskId: 'task', changes: {} }).success).toBe(false);
});
it('narrow task grants permit basic creation/completion but cannot assign, place or delete tasks', async () => {
  const f = await fixture(); f.store.value!.scopes = ['task:task:writeonly'];
  const input = { summary: 'fixture', clientToken: 'task-create-1' };
  await tool('tasks_create').invoke(f.app, input);
  await tool('tasks_update').invoke(f.app, { taskId: 'task', changes: { completed_at: '0' } });
  await expect(tool('tasks_create').invoke(f.app, { ...input, members: [{ id: 'ou_recipient', role: 'assignee' }] })).rejects.toMatchObject({ kind: 'MISSING_SCOPE' });
  await expect(tool('tasks_create').invoke(f.app, { ...input, tasklists: [{ tasklist_guid: 'list' }] })).rejects.toMatchObject({ kind: 'MISSING_SCOPE' });
  await expect(tool('tasks_delete').invoke(f.app, { taskId: 'task' })).rejects.toMatchObject({ kind: 'MISSING_SCOPE' });
  expect(f.requests).toHaveLength(2);
});
it('scheduling uses explicit notification choice and user attendee identities', async () => {
  const f = await fixture();
  const event = { calendarId: 'fixture@group.calendar.feishu.cn', eventId: 'event' };
  expect(tool('calendar_attendees_add').schema.safeParse({ ...event, userIds: ['ou_recipient'] }).success).toBe(false);
  await tool('calendar_attendees_add').invoke(f.app, { ...event, userIds: ['ou_recipient'], notify: false });
  expect(body(f.requests[0]!)).toEqual({ attendees: [{ type: 'user', user_id: 'ou_recipient', is_optional: false }], need_notification: false });
});
it('XLSX worker extracts shared/inline strings and formulas without evaluation', async () => {
  const bytes = Buffer.from(zipSync({ 'xl/sharedStrings.xml': strToU8('<sst><si><t>Hello &amp; goodbye</t></si></sst>'), 'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Inline</t></is></c><c r="C1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>') }));
  const result = await extractAttachment(bytes, 'fixture.xlsx');
  expect(result.text).toContain('A1\tHello & goodbye'); expect(result.text).toContain('B1\tInline'); expect(result.text).toContain('C1\t[formula: 1+1; cached: 2]');
  expect(result.note).toContain('never evaluated'); expect(result.truncated).toBe(false);
});
it('PPTX worker extracts slide text and rejects unsafe XML and unsupported binary formats', async () => {
  const bytes = Buffer.from(zipSync({ 'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:sld>') }));
  expect((await extractAttachment(bytes, 'fixture.pptx')).text).toContain('Hello');
  const unsafe = Buffer.from(zipSync({ 'ppt/slides/slide1.xml': strToU8('<!DOCTYPE foo SYSTEM "https://evil.invalid"><a:p><a:t>foo</a:t></a:p>') }));
  await expect(extractAttachment(unsafe, 'fixture.pptx')).rejects.toMatchObject({ kind: 'ATTACHMENT_PARSE_FAILED' });
  await expect(extractAttachment(Buffer.from('binary'), 'fixture.xls')).rejects.toMatchObject({ kind: 'UNSUPPORTED_ATTACHMENT' });
});
