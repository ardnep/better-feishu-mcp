import { z } from 'zod';
import { idSchema } from './core.js';
import { encode as e, endpoint, pageInput, shortText, type ProductivityTool } from './productivity.js';
const space = { spaceId: z.string().regex(/^[0-9]{1,32}$/) };
const node = { ...space, nodeToken: idSchema };
const spacePath = (a: { spaceId: string }) => `/wiki/v2/spaces/${e(a.spaceId)}`;
const nodePath = (a: { spaceId: string; nodeToken: string }) => `${spacePath(a)}/nodes/${e(a.nodeToken)}`;
const scope = (name: string, read = false) => [[name, 'wiki:wiki', ...(read ? ['wiki:wiki:readonly'] : [])]];
export const wikiTools: ProductivityTool[] = [
  endpoint('wiki_spaces_list', 'List a bounded page of accessible knowledge spaces.', z.object(pageInput).strict(), scope('wiki:space:retrieve', true), 'GET', () => ({ path: '/wiki/v2/spaces', page: true })),
  endpoint('wiki_spaces_get', 'Read one knowledge space.', z.object(space).strict(), scope('wiki:space:read', true), 'GET', a => ({ path: spacePath(a) })),
  endpoint('wiki_spaces_create', 'Create a private knowledge space. External/public sharing is never enabled by this tool.', z.object({ name: shortText, description: z.string().max(2000).optional() }).strict(), scope('wiki:space:write_only'), 'POST', a => ({ path: '/wiki/v2/spaces', body: { name: a.name, description: a.description, open_sharing: 'closed' }, lock: 'wiki-create' })),
  endpoint('wiki_nodes_list', 'List a bounded page of children, or root nodes when parentNodeToken is omitted.', z.object({ ...space, parentNodeToken: idSchema.optional(), ...pageInput }).strict(), scope('wiki:node:retrieve', true), 'GET', a => ({ path: `${spacePath(a)}/nodes`, query: { parent_node_token: a.parentNodeToken }, page: true })),
  endpoint('wiki_nodes_create', 'Create a native document, Sheet, Base, mind map or slides node in a Wiki space. This creates its container; content editing uses the relevant product tools.', z.object({ ...space, title: shortText, parentNodeToken: idSchema.optional(), objectType: z.enum(['docx', 'sheet', 'bitable', 'mindnote', 'slides']) }).strict(), scope('wiki:node:create'), 'POST', a => ({ path: `${spacePath(a)}/nodes`, body: { title: a.title, node_type: 'origin', obj_type: a.objectType, parent_node_token: a.parentNodeToken }, lock: spacePath(a) })),
  endpoint('wiki_nodes_rename', 'Rename one Wiki node; does not rewrite its document body.', z.object({ ...node, title: shortText }).strict(), scope('wiki:node:update'), 'POST', a => ({ path: `${nodePath(a)}/update_title`, body: { title: a.title }, lock: spacePath(a) })),
  endpoint('wiki_nodes_move', 'Move an explicit Wiki node to an explicit target space/parent. May return an asynchronous task ID; no automatic polling/replay.', z.object({ ...node, targetSpaceId: space.spaceId, targetParentToken: idSchema.optional() }).strict(), scope('wiki:node:move'), 'POST', a => ({ path: `${nodePath(a)}/move`, body: { target_space_id: a.targetSpaceId, target_parent_token: a.targetParentToken }, lock: 'wiki-move' })),
  endpoint('wiki_nodes_copy', 'Copy an explicit Wiki node to an explicit destination. May return an asynchronous task ID.', z.object({ ...node, targetSpaceId: space.spaceId, targetParentToken: idSchema.optional(), title: shortText.optional() }).strict(), scope('wiki:node:copy'), 'POST', a => ({ path: `${nodePath(a)}/copy`, body: { target_space_id: a.targetSpaceId, target_parent_token: a.targetParentToken, title: a.title }, lock: 'wiki-copy' })),
];
