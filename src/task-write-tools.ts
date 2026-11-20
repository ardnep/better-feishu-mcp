import { z } from 'zod';
import { AppError, idSchema, requireScopes } from './core.js';
import { openId } from './discovery-tools.js';
import { encode as e, endpoint, pageInput, type ProductivityTool } from './productivity.js';
const user = { user_id_type: 'open_id' };
const time = z.object({ timestamp: z.string().regex(/^[0-9]{1,16}$/), is_all_day: z.boolean().default(false) }).strict();
const fields = { summary: z.string().min(1).max(3000), description: z.string().max(3000).optional(), start: time.optional(), due: time.optional(), completed_at: z.string().regex(/^[0-9]{1,16}$/).optional() };
const member = z.object({ id: openId, type: z.literal('user').default('user'), role: z.enum(['assignee', 'follower']) }).strict();
const listMember = z.object({ id: openId, type: z.literal('user').default('user'), role: z.enum(['editor', 'viewer']) }).strict();
const task = { taskId: idSchema };
const list = { tasklistId: idSchema };
const root = (a: { taskId: string }) => `/task/v2/tasks/${e(a.taskId)}`;
const listRoot = (a: { tasklistId: string }) => `/task/v2/tasklists/${e(a.tasklistId)}`;
export const taskWriteTools: ProductivityTool[] = [
  endpoint('tasks_create', 'Create a task with optional start/deadline. Explicit assignees/followers and task-list placement require full task:task:write; narrow writeonly permits basic creation only. Times are Unix milliseconds. clientToken supports provider idempotency; do not replay uncertain creates with a new token.', z.object({ ...fields, members: z.array(member).max(50).optional(), tasklists: z.array(z.object({ tasklist_guid: idSchema, section_guid: idSchema.optional() }).strict()).max(20).optional(), clientToken: z.string().min(1).max(100) }).strict(), [['task:task:write', 'task:task:writeonly']], 'POST', a => { const { clientToken, ...values } = a; return { path: '/task/v2/tasks', query: user, body: { ...values, client_token: clientToken }, lock: 'task-create' }; }),
  endpoint('tasks_update', 'Update only supplied task fields. completed_at is Unix milliseconds; use "0" to reopen. A due/start timestamp of "0" clears it. No implicit reassignment.', z.object({ ...task, changes: z.object({ ...fields, summary: fields.summary.optional() }).strict().refine(a => Object.keys(a).length > 0, 'Supply at least one change.') }).strict(), [['task:task:write', 'task:task:writeonly']], 'PATCH', a => ({ path: root(a), query: user, body: { task: a.changes, update_fields: Object.keys(a.changes) }, lock: root(a) })),
  endpoint('tasks_delete', 'Delete one explicit task. Destructive; does not delete its task list.', z.object(task).strict(), ['task:task:write'], 'DELETE', a => ({ path: root(a), lock: root(a) })),
  ...(['add', 'remove'] as const).map(action => endpoint(`tasks_members_${action}`, `${action === 'add' ? 'Add' : 'Remove'} explicitly named task assignees/followers. May notify affected users.`, z.object({ ...task, members: z.array(member).min(1).max(50) }).strict(), ['task:task:write'], 'POST', a => ({ path: `${root(a)}/${action}_members`, query: user, body: { members: a.members }, lock: root(a) }))),
  endpoint('tasks_add_tasklist', 'Add an existing task to an explicit task list and optional section.', z.object({ ...task, ...list, sectionId: idSchema.optional() }).strict(), ['task:task:write'], 'POST', a => ({ path: `${root(a)}/add_tasklist`, query: user, body: { tasklist_guid: a.tasklistId, section_guid: a.sectionId }, lock: root(a) })),
  endpoint('tasks_remove_tasklist', 'Remove a task from one list without deleting the task.', z.object({ ...task, ...list }).strict(), ['task:task:write'], 'POST', a => ({ path: `${root(a)}/remove_tasklist`, query: user, body: { tasklist_guid: a.tasklistId }, lock: root(a) })),
  endpoint('tasklists_create', 'Create a task list with optional explicitly named editors/viewers. Does not transfer ownership.', z.object({ name: z.string().min(1).max(100), members: z.array(listMember).max(50).optional() }).strict(), ['task:tasklist:write'], 'POST', a => ({ path: '/task/v2/tasklists', query: user, body: a, lock: 'tasklist-create' })),
  endpoint('tasklists_update', 'Rename an explicit task list without changing its owner.', z.object({ ...list, name: z.string().min(1).max(100) }).strict(), ['task:tasklist:write'], 'PATCH', a => ({ path: listRoot(a), query: user, body: { tasklist: { name: a.name }, update_fields: ['name'] }, lock: listRoot(a) })),
  endpoint('tasklists_delete', 'Delete an explicit task list. Destructive; inspect the list first.', z.object(list).strict(), ['task:tasklist:write'], 'DELETE', a => ({ path: listRoot(a), lock: listRoot(a) })),
  endpoint('tasklists_tasks', 'List a bounded page of tasks in an explicit task list.', z.object({ ...list, ...pageInput, completed: z.boolean().optional() }).strict(), [['task:tasklist:read', 'task:tasklist:write']], 'GET', a => ({ path: `${listRoot(a)}/tasks`, query: { ...user, completed: a.completed }, page: true })),
  ...(['add', 'remove'] as const).map(action => endpoint(`tasklists_members_${action}`, `${action === 'add' ? 'Add/change' : 'Remove'} explicitly named task-list editors/viewers. Does not transfer ownership.`, z.object({ ...list, members: z.array(listMember).min(1).max(50) }).strict(), ['task:tasklist:write'], 'POST', a => ({ path: `${listRoot(a)}/${action}_members`, query: user, body: { members: a.members }, lock: listRoot(a) }))),
];
// Narrow create/update grants are not a substitute for personnel/list writes.
const create = taskWriteTools.find(t => t.name === 'tasks_create')!;
const invokeCreate = create.invoke;
create.invoke = async (context, raw, signal) => {
  const input = create.schema.parse(raw) as { members?: unknown[]; tasklists?: unknown[] };
  if (!context.config.writes) throw new AppError('WRITES_DISABLED', 'Writes must be enabled.');
  if (input.members?.length || input.tasklists?.length) requireScopes((await context.sessions.token()).scopes, ['task:task:write']);
  return invokeCreate(context, raw, signal);
};
