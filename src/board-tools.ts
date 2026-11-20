import { z } from 'zod';
import { boardIdSchema } from './boards.js';
import { encode as e, endpoint, type ProductivityTool } from './productivity.js';
export const boardTools: ProductivityTool[] = [
  endpoint('boards_delete_nodes', 'Delete up to 100 explicit native board nodes. Destructive; no document revision precondition is available in this API.', z.object({ boardId: boardIdSchema, nodeIds: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_:\-]+$/)).min(1).max(100) }).strict(), ['board:whiteboard:node:delete'], 'DELETE', a => ({ path: `/board/v1/whiteboards/${e(a.boardId)}/nodes/batch_delete`, body: { ids: a.nodeIds }, lock: a.boardId })),
];
