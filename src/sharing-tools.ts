import { z } from 'zod';
import { idSchema } from './core.js';
import { openId } from './discovery-tools.js';
import { encode as e, endpoint, type ProductivityTool } from './productivity.js';
const resource = { token: idSchema, type: z.enum(['doc', 'docx', 'sheet', 'bitable', 'file', 'folder', 'wiki', 'mindnote', 'slides']) };
const member = { userId: openId };
const role = { permission: z.enum(['view', 'edit', 'full_access']), notify: z.boolean().default(false) };
const root = (a: { token: string }) => `/drive/v1/permissions/${e(a.token)}`;
export const sharingTools: ProductivityTool[] = [
  endpoint('sharing_members_list', 'Inspect collaborators of an explicit document. Does not expand inherited access or alter sharing.', z.object(resource).strict(), ['docs:permission.member:retrieve'], 'GET', a => ({ path: `${root(a)}/members`, query: { type: a.type, fields: 'name,type' } })),
  endpoint('sharing_settings_get', 'Read current document public-sharing settings. This tool cannot change them.', z.object(resource).strict(), ['docs:permission.setting:read'], 'GET', a => ({ path: `${root(a)}/public`, query: { type: a.type } })),
  endpoint('sharing_members_add', 'Grant an explicitly named user access. full_access allows managing collaborators; never choose it implicitly. No public links or owner transfer.', z.object({ ...resource, ...member, ...role }).strict(), ['docs:permission.member:create'], 'POST', a => ({ path: `${root(a)}/members`, query: { type: a.type, need_notification: a.notify }, body: { member_type: 'openid', member_id: a.userId, type: 'user', perm: a.permission }, lock: root(a) })),
  endpoint('sharing_members_update', 'Change an explicitly named user’s collaborator role. Does not transfer ownership.', z.object({ ...resource, ...member, ...role }).strict(), ['docs:permission.member:update'], 'PUT', a => ({ path: `${root(a)}/members/${e(a.userId)}`, query: { type: a.type, need_notification: a.notify }, body: { member_type: 'openid', type: 'user', perm: a.permission }, lock: root(a) })),
  endpoint('sharing_members_delete', 'Revoke an explicitly named user’s direct collaboration grant. Inherited/group access may remain.', z.object({ ...resource, ...member }).strict(), ['docs:permission.member:delete'], 'DELETE', a => ({ path: `${root(a)}/members/${e(a.userId)}`, query: { type: a.type, member_type: 'openid' }, body: { type: 'user' }, lock: root(a) })),
];
