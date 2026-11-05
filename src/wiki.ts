import { z } from 'zod';
import { AppError, feishuLinkToken, idSchema } from './core.js';
import { FeishuHttp } from './http.js';

const nodeSchema = z.object({ node: z.object({ obj_type: z.string(), obj_token: idSchema }) });
export async function resolveWiki(api: FeishuHttp, reference: string, expectedType: 'docx' | 'sheet', signal?: AbortSignal): Promise<string> {
  const nodeToken = feishuLinkToken(reference, 'wiki');
  if (!nodeToken) return reference;
  const query = new URLSearchParams({ token: nodeToken, obj_type: 'wiki' });
  const { node } = await api.request('GET', '/wiki/v2/spaces/get_node?' + query, nodeSchema, {
    scopes: [['wiki:node:read', 'wiki:wiki:readonly', 'wiki:wiki']], signal,
  });
  if (node.obj_type !== expectedType) throw new AppError('WIKI_TYPE_MISMATCH', 'Wiki node contains a different resource type. Use the corresponding reader; legacy Docs and Base are not supported.', {
    expectedType, actualType: node.obj_type, ...(node.obj_type === 'docx' ? { useTool: 'documents_get' } : node.obj_type === 'sheet' ? { useTool: 'sheets_get' } : {}),
  });
  return node.obj_token;
}
