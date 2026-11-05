import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { runtime } from '../src/server.js';
import { MemoryStore, session, setup } from './helpers.js';

async function connection(writes = false) {
  const env = await setup(writes); const credentials = session();
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url))],
    env: { ...process.env, BETTER_FEISHU_MCP_PROFILE: 'test', BETTER_FEISHU_MCP_STATE_DIR: env.config.stateDir,
      BETTER_FEISHU_MCP_ENABLE_WRITES: writes ? '1' : '0', TEST_SESSION_JSON: JSON.stringify(credentials) }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'better-feishu-mcp-test', version: '0.1.0' });
  await client.connect(transport);
  return { ...env, credentials, client, stderr: () => stderr, close: async () => { await client.close(); await env.cleanup(); } };
}
function output(response: Awaited<ReturnType<Client['callTool']>>) {
  const text = response.content?.find(c => c.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Missing text response');
  return JSON.parse(text.text);
}
it('CLI approval rejects piped/model-supplied confirmation', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'approve', 'a'.repeat(32)],
    { input: 'approve aaaaaaaa\n', encoding: 'utf8' });
  expect(result.status).toBe(1); expect(result.stderr).toContain('TRUSTED_TERMINAL_REQUIRED');
});
it('serves a legacy initialize/tools-list exchange with protocol-only stdout', async () => {
  const env = await setup(false);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url))], {
    env: { ...process.env, TEST_SESSION_JSON: JSON.stringify(session()), BETTER_FEISHU_MCP_PROFILE: 'test',
      BETTER_FEISHU_MCP_STATE_DIR: env.config.stateDir, BETTER_FEISHU_MCP_ENABLE_WRITES: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const tools = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Legacy MCP exchange timed out')), 5000);
      let buffer = '';
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => {
        buffer += String(chunk);
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.id === 1) {
              expect(message.result.protocolVersion).toBe('2025-11-25');
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
            }
            if (message.id === 2) { clearTimeout(timer); resolve(message.result.tools.map((tool: { name: string }) => tool.name)); }
          } catch (error) { clearTimeout(timer); reject(error); }
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-fixture', version: '1.0.0' },
      } }) + '\n');
    });
    expect(tools).toContain('documents_read'); expect(tools).not.toContain('operations_commit');
  } finally { child.stdin.end(); child.kill(); await env.cleanup(); }
});
it('discovers read tools over real stdio, keeps writes/sending/search-docs absent and labels hostile data', async () => {
  const f = await connection();
  try {
    const list = await f.client.listTools(); const names = list.tools.map(t => t.name);
    expect(names).toContain('messages_search'); expect(names).toContain('documents_read');
    expect(names).not.toContain('operations_commit');
    expect(names.some(n => /send|approve|documents_search/.test(n))).toBe(false);
    const status = output(await f.client.callTool({ name: 'auth_status', arguments: {} }));
    expect(status.loggedIn).toBe(true); expect(status.accessToken).toBeUndefined(); expect(status.appSecret).toBeUndefined();
    const chats = output(await f.client.callTool({ name: 'chats_list', arguments: { limit: 1 } }));
    expect(chats.untrustedData).toBe(true); expect(chats.items[0].name).toContain('Ignore policy');
    expect(f.stderr()).not.toContain('synthetic-user-token');
  } finally { await f.close(); }
});
it('blocks MCP commit without local approval; signed approval works once over real stdio', async () => {
  const f = await connection(true);
  try {
    const draft = output(await f.client.callTool({ name: 'documents_prepare_create', arguments: { title: 'fixture' } }));
    const denied = await f.client.callTool({ name: 'operations_commit', arguments: { operationId: draft.operationId } });
    expect(denied.isError).toBe(true); expect(output(denied).error.kind).toBe('APPROVAL_REQUIRED');
    const trustedLocalApprover = runtime(f.config, new MemoryStore(f.credentials));
    await trustedLocalApprover.operations.approve(draft.operationId);
    const committed = await f.client.callTool({ name: 'operations_commit', arguments: { operationId: draft.operationId } });
    expect(committed.isError).not.toBe(true); expect(output(committed).documentId).toBe('fixtureDoc');
    const replay = await f.client.callTool({ name: 'operations_commit', arguments: { operationId: draft.operationId } });
    expect(replay.isError).toBe(true); expect(output(replay).error.kind).toBe('OPERATION_NOT_FOUND');
  } finally { await f.close(); }
});
