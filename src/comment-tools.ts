import { z } from 'zod';
import { idSchema } from './core.js';
import { encode as e, endpoint, pageInput, text, type ProductivityTool } from './productivity.js';
const file = { fileToken: idSchema, fileType: z.enum(['docx', 'doc', 'sheet', 'file']) };
const comment = { ...file, commentId: idSchema };
const reply = { ...comment, replyId: idSchema };
const root = (a: { fileToken: string }) => `/drive/v1/files/${e(a.fileToken)}/comments`;
const query = (a: { fileType: string }) => ({ file_type: a.fileType, user_id_type: 'open_id' });
const content = (value: string) => ({ elements: [{ type: 'text_run', text_run: { text: value } }] });
export const commentTools: ProductivityTool[] = [
  endpoint('comments_list', 'Read a bounded page of document comments.', z.object({ ...file, ...pageInput, isSolved: z.boolean().optional() }).strict(), ['docs:document.comment:read'], 'GET', a => ({ path: root(a), query: { ...query(a), is_solved: a.isSolved }, page: true })),
  endpoint('comments_create', 'Add a whole-document plain-text comment. Does not mention users or anchor to document ranges.', z.object({ ...file, text }).strict(), ['docs:document.comment:create'], 'POST', a => ({ path: root(a), query: query(a), body: { reply_list: { replies: [{ content: content(a.text) }] } }, lock: a.fileToken })),
  endpoint('comments_resolve', 'Resolve or reopen an explicit comment thread.', z.object({ ...comment, isSolved: z.boolean() }).strict(), ['docs:document.comment:update'], 'PATCH', a => ({ path: `${root(a)}/${e(a.commentId)}`, query: query(a), body: { is_solved: a.isSolved }, lock: a.fileToken })),
  endpoint('comments_reply', 'Add a plain-text reply to an explicit comment.', z.object({ ...comment, text }).strict(), ['docs:document.comment:create'], 'POST', a => ({ path: `${root(a)}/${e(a.commentId)}/replies`, query: query(a), body: { content: content(a.text) }, lock: a.fileToken })),
  endpoint('comments_reply_update', 'Replace the text of one authorized comment reply.', z.object({ ...reply, text }).strict(), ['docs:document.comment:update'], 'PUT', a => ({ path: `${root(a)}/${e(a.commentId)}/replies/${e(a.replyId)}`, query: query(a), body: { content: content(a.text) }, lock: a.fileToken })),
  endpoint('comments_reply_delete', 'Delete one authorized reply, not an entire comment thread.', z.object(reply).strict(), ['docs:document.comment:delete'], 'DELETE', a => ({ path: `${root(a)}/${e(a.commentId)}/replies/${e(a.replyId)}`, query: query(a), lock: a.fileToken })),
];
