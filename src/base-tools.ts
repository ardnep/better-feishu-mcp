import { z } from 'zod';
import { idSchema } from './core.js';
import { dataObject, encode as e, endpoint, pageInput, shortText, type ProductivityTool } from './productivity.js';

const app = { appToken: idSchema };
const table = { ...app, tableId: idSchema };
const root = (a: { appToken: string }) => `/bitable/v1/apps/${e(a.appToken)}`;
const tablePath = (a: { appToken: string; tableId: string }) => `${root(a)}/tables/${e(a.tableId)}`;
const scope = (name: string, read = false) => [[name, ...(read ? ['bitable:app:readonly'] : []), 'bitable:app']];
const field = z.object({ field_name: shortText, type: z.number().int().min(1).max(1005), property: dataObject.optional(),
  description: z.object({ text: z.string().max(2000), disable_sync: z.boolean().optional() }).strict().optional() }).strict();
const filter = z.object({ conjunction: z.enum(['and', 'or']), conditions: z.array(z.object({
  field_name: shortText, operator: z.enum(['is', 'isNot', 'contains', 'doesNotContain', 'isEmpty', 'isNotEmpty', 'isGreater', 'isGreaterEqual', 'isLess', 'isLessEqual']),
  value: z.array(z.string().max(1000)).max(50).optional(),
}).strict()).max(20) }).strict();
export const baseTools: ProductivityTool[] = [
  endpoint('base_get', 'Read Base metadata from its app token.', z.object(app).strict(), scope('base:app:read', true), 'GET', a => ({ path: root(a) })),
  endpoint('base_create', 'Create a Base, optionally in an explicit Drive folder.', z.object({ name: shortText, folderToken: idSchema.optional(), timeZone: z.string().max(100).optional() }).strict(), scope('base:app:create'), 'POST', a => ({ path: '/bitable/v1/apps', body: { name: a.name, folder_token: a.folderToken, time_zone: a.timeZone }, lock: 'base-create' })),
  endpoint('base_tables_list', 'List a bounded page of tables in a Base.', z.object({ ...app, ...pageInput }).strict(), scope('base:table:read', true), 'GET', a => ({ path: `${root(a)}/tables`, page: true })),
  endpoint('base_tables_create', 'Create a table in a Base.', z.object({ ...app, name: shortText, defaultViewName: shortText.optional() }).strict(), scope('base:table:create'), 'POST', a => ({ path: `${root(a)}/tables`, body: { table: { name: a.name, default_view_name: a.defaultViewName } }, lock: root(a) })),
  endpoint('base_tables_update', 'Rename an existing Base table.', z.object({ ...table, name: shortText }).strict(), scope('base:table:update'), 'PATCH', a => ({ path: tablePath(a), body: { name: a.name }, lock: root(a) })),
  endpoint('base_tables_delete', 'Delete one explicit Base table, including its records. Destructive.', z.object(table).strict(), scope('base:table:delete'), 'DELETE', a => ({ path: tablePath(a), lock: root(a) })),
  endpoint('base_fields_list', 'Read a bounded page of table fields/schema.', z.object({ ...table, ...pageInput }).strict(), scope('base:field:read', true), 'GET', a => ({ path: `${tablePath(a)}/fields`, page: true })),
  endpoint('base_fields_create', 'Add a typed field. Property values follow the native Base field schema; no permission management.', z.object({ ...table, field }).strict(), scope('base:field:create'), 'POST', a => ({ path: `${tablePath(a)}/fields`, body: a.field, lock: root(a) })),
  endpoint('base_fields_update', 'Update an explicit field definition. Changing type can affect stored values.', z.object({ ...table, fieldId: idSchema, field }).strict(), scope('base:field:update'), 'PUT', a => ({ path: `${tablePath(a)}/fields/${e(a.fieldId)}`, body: a.field, lock: root(a) })),
  endpoint('base_fields_delete', 'Delete one explicit field and its values. Destructive.', z.object({ ...table, fieldId: idSchema }).strict(), scope('base:field:delete'), 'DELETE', a => ({ path: `${tablePath(a)}/fields/${e(a.fieldId)}`, lock: root(a) })),
  endpoint('base_views_list', 'List a bounded page of views; no view or access-policy mutation.', z.object({ ...table, ...pageInput }).strict(), scope('base:view:read', true), 'GET', a => ({ path: `${tablePath(a)}/views`, page: true })),
  endpoint('base_records_get', 'Read one record using app-specific open IDs for people fields.', z.object({ ...table, recordId: idSchema }).strict(), scope('base:record:read', true), 'GET', a => ({ path: `${tablePath(a)}/records/${e(a.recordId)}`, query: { user_id_type: 'open_id' } })),
  endpoint('base_records_search', 'Search a bounded page of records with explicit filters. This POST is a read, not a mutation.', z.object({ ...table, ...pageInput, viewId: idSchema.optional(), fieldNames: z.array(shortText).max(50).optional(), filter: filter.optional() }).strict(), scope('base:record:retrieve', true), 'POST', a => ({ path: `${tablePath(a)}/records/search`, query: { user_id_type: 'open_id' }, body: { view_id: a.viewId, field_names: a.fieldNames, filter: a.filter }, page: true }), false),
  endpoint('base_records_create', 'Create one record with bounded native field values. Reads/schema discovery should precede writes.', z.object({ ...table, fields: dataObject }).strict(), scope('base:record:create'), 'POST', a => ({ path: `${tablePath(a)}/records`, query: { user_id_type: 'open_id' }, body: { fields: a.fields }, lock: root(a) })),
  endpoint('base_records_update', 'Update the supplied fields on one explicit record; other fields are preserved.', z.object({ ...table, recordId: idSchema, fields: dataObject }).strict(), scope('base:record:update'), 'PUT', a => ({ path: `${tablePath(a)}/records/${e(a.recordId)}`, query: { user_id_type: 'open_id' }, body: { fields: a.fields }, lock: root(a) })),
  endpoint('base_records_delete', 'Delete one explicit record. Destructive.', z.object({ ...table, recordId: idSchema }).strict(), scope('base:record:delete'), 'DELETE', a => ({ path: `${tablePath(a)}/records/${e(a.recordId)}`, lock: root(a) })),
];
