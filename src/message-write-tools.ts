import { z } from 'zod';
import { AppError, requireScopes } from './core.js';
import { openId } from './discovery-tools.js';
import { encode as e, endpoint, type ProductivityTool } from './productivity.js';
import { localPath } from './transfers.js';
const chatId = z.string().max(128).regex(/^oc_[A-Za-z0-9_-]+$/);
const messageId = z.string().max(128).regex(/^om_[A-Za-z0-9_-]+$/);
const key = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const payload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(10_000) }).strict(),
  z.object({ type: z.literal('image'), imageKey: key }).strict(),
  z.object({ type: z.literal('file'), fileKey: key }).strict(),
]);
const delivery = { content: payload, uuid: z.string().min(1).max(50).regex(/^[A-Za-z0-9_-]+$/) };
function body(a: { content: z.infer<typeof payload>; uuid: string }) {
  const c = a.content;
  return { uuid: a.uuid, msg_type: c.type, content: JSON.stringify(c.type === 'text' ? { text: c.text } : c.type === 'image' ? { image_key: c.imageKey } : { file_key: c.fileKey }) };
}
const sendScopes = ['im:message', 'im:message.send_as_user'];
const recallSchema = z.object({ messageId, visibility: z.enum(['group', 'p2p']) }).strict();
const recall = endpoint('messages_recall', 'Recall your own message for the entire conversation, not just hide it locally. Ownership is checked first. Provider recall windows and chat policy still apply.', recallSchema, ['im:message'], 'DELETE', a => ({ path: `/im/v1/messages/${e(a.messageId)}`, lock: a.messageId }));
const recallInvoke = recall.invoke;
recall.invoke = async (context, raw, signal) => {
  const a = recallSchema.parse(raw);
  if (!context.config.writes) throw new AppError('WRITES_DISABLED', 'Writes must be enabled.');
  const session = await context.sessions.token();
  const scopes = ['im:message', a.visibility === 'group' ? 'im:message.group_msg:get_as_user' : 'im:message.p2p_msg:get_as_user'];
  requireScopes(session.scopes, scopes);
  const data = await context.api.request('GET', `/im/v1/messages/${e(a.messageId)}`, z.object({ items: z.array(z.object({ message_id: z.string(), sender: z.object({ id: z.string(), id_type: z.string(), sender_type: z.string() }) })) }), { scopes, signal });
  const own = data.items.length === 1 && data.items[0]!.message_id === a.messageId && data.items[0]!.sender.id_type === 'open_id' && data.items[0]!.sender.sender_type === 'user' && data.items[0]!.sender.id === session.userId;
  if (!own) throw new AppError('NOT_MESSAGE_OWNER', 'Only messages verified as sent by the current user can be recalled.');
  return recallInvoke(context, a, signal);
};
export const messageWriteTools: ProductivityTool[] = [
  endpoint('messages_send', 'Send text or a native uploaded image/file as the consenting user to an explicit recipient. uuid is required: reuse only for the exact same intended delivery within the provider’s one-hour deduplication window. Never blindly retry uncertain delivery; no bot fallback.', z.object({ recipient: z.discriminatedUnion('type', [z.object({ type: z.literal('open_id'), id: openId }).strict(), z.object({ type: z.literal('chat_id'), id: chatId }).strict()]), ...delivery }).strict(), sendScopes, 'POST', a => ({ path: '/im/v1/messages', query: { receive_id_type: a.recipient.type }, body: { receive_id: a.recipient.id, ...body(a) }, lock: `send-${a.recipient.id}` })),
  endpoint('messages_reply', 'Reply as the consenting user to an explicit message, optionally in a thread. Required uuid deduplicates one exact reply for one hour. No bot fallback.', z.object({ messageId, ...delivery, replyInThread: z.boolean().default(false) }).strict(), sendScopes, 'POST', a => ({ path: `/im/v1/messages/${e(a.messageId)}/reply`, body: { ...body(a), reply_in_thread: a.replyInThread }, lock: a.messageId })),
  recall,
  endpoint('messages_upload_image', 'Upload a local image for native chat sending; does not send it. Returns image_key, not a Drive token. Canonical regular files only; local upload safety limit is 5 MB.', z.object({ path: localPath }).strict(), ['im:resource'], 'POST', a => ({ path: '/im/v1/images', upload: { path: a.path, fields: { image_type: 'message' }, fileField: 'image' }, lock: 'im-upload-image' })),
  endpoint('messages_upload_file', 'Upload a local file for native chat sending; does not send it. Returns file_key, not a Drive token. Canonical regular files only; local upload safety limit is 5 MB.', z.object({ path: localPath, fileName: z.string().min(1).max(255), fileType: z.enum(['pdf', 'doc', 'xls', 'ppt', 'stream']).default('stream') }).strict(), ['im:resource'], 'POST', a => ({ path: '/im/v1/files', upload: { path: a.path, fields: { file_type: a.fileType, file_name: a.fileName } }, lock: 'im-upload-file' })),
  endpoint('chats_update', 'Change only the explicitly supplied group name/description. Does not alter visibility, ownership or security settings.', z.object({ chatId, name: z.string().min(1).max(60).optional(), description: z.string().max(100).optional() }).strict().refine(a => a.name !== undefined || a.description !== undefined, 'Supply name or description.'), ['im:chat:update'], 'PUT', a => ({ path: `/im/v1/chats/${e(a.chatId)}`, body: { name: a.name, description: a.description }, lock: a.chatId })),
  ...(['add', 'delete'] as const).map(action => endpoint(`chats_members_${action}`, action === 'add' ? 'Invite explicitly named human users to a group. Never invites bots; group policy may require approval.' : 'Remove explicitly named human users from a group. Does not remove bots.', z.object({ chatId, userIds: z.array(openId).min(1).max(50).refine(ids => new Set(ids).size === ids.length, 'Duplicate users are not allowed.') }).strict(), ['im:chat.members:write_only'], action === 'add' ? 'POST' : 'DELETE', a => ({ path: `/im/v1/chats/${e(a.chatId)}/members`, query: { member_id_type: 'open_id', ...(action === 'add' ? { succeed_type: 0 } : {}) }, body: { id_list: a.userIds }, lock: a.chatId }))),
];
