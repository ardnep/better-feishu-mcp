import { z } from 'zod';
import { idSchema } from './core.js';
import { encode as e, endpoint, pageInput, type ProductivityTool } from './productivity.js';
const chatId = z.string().max(128).regex(/^oc_[A-Za-z0-9_-]+$/);
const messageId = z.string().max(128).regex(/^om_[A-Za-z0-9_-]+$/);
export const chatTools: ProductivityTool[] = [
  endpoint('chats_members', 'List a bounded page of group members using open IDs. Does not invite users or bots.', z.object({ chatId, ...pageInput }).strict(), [['im:chat.members:read', 'im:chat:readonly', 'im:chat']], 'GET', a => ({ path: `/im/v1/chats/${e(a.chatId)}/members`, query: { member_id_type: 'open_id' }, page: true })),
  endpoint('messages_reactions_list', 'List a bounded page of reactions on a message.', z.object({ messageId, ...pageInput }).strict(), [['im:message.reactions:read', 'im:message:readonly', 'im:message']], 'GET', a => ({ path: `/im/v1/messages/${e(a.messageId)}/reactions`, query: { user_id_type: 'open_id' }, page: true })),
  endpoint('messages_reactions_add', 'Add one reaction as the authorized user. Not message sending.', z.object({ messageId, emojiType: z.string().min(1).max(100).regex(/^[A-Za-z0-9_]+$/) }).strict(), [['im:message.reactions:write_only', 'im:message']], 'POST', a => ({ path: `/im/v1/messages/${e(a.messageId)}/reactions`, body: { reaction_type: { emoji_type: a.emojiType } }, lock: a.messageId })),
  endpoint('messages_reactions_delete', 'Remove one reaction created by the authorized user; cannot remove others’ reactions.', z.object({ messageId, reactionId: idSchema }).strict(), [['im:message.reactions:write_only', 'im:message']], 'DELETE', a => ({ path: `/im/v1/messages/${e(a.messageId)}/reactions/${e(a.reactionId)}`, lock: a.messageId })),
  endpoint('messages_pins_list', 'List a bounded page of pinned messages in an explicit chat.', z.object({ chatId, ...pageInput }).strict(), [['im:message.pins:read', 'im:message:readonly', 'im:message']], 'GET', a => ({ path: '/im/v1/pins', query: { chat_id: a.chatId }, page: true })),
  endpoint('messages_pin', 'Pin one explicit message in its chat, subject to chat-role restrictions.', z.object({ messageId }).strict(), [['im:message.pins:write_only', 'im:message']], 'POST', a => ({ path: '/im/v1/pins', body: { message_id: a.messageId }, lock: a.messageId })),
  endpoint('messages_unpin', 'Unpin one explicit message, subject to chat-role restrictions.', z.object({ messageId }).strict(), [['im:message.pins:write_only', 'im:message']], 'DELETE', a => ({ path: `/im/v1/pins/${e(a.messageId)}`, lock: a.messageId })),
];
