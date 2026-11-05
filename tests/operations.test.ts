import { it, expect, vi } from 'vitest';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '../src/credentials.js';
import { Documents, fingerprint } from '../src/services.js';
import { FeishuHttp } from '../src/http.js';
import { Operations } from '../src/operations.js';
import { MemoryStore, fakeFetch, json, session, setup } from './helpers.js';

async function fixture(writes = true) {
  const env = await setup(writes); const store = new MemoryStore(); const manager = new SessionManager(store, env.config);
  let revision = 1; let creates = 0; let mutations = 0;
  const documents = new Documents(new FeishuHttp(() => manager.token(), fakeFetch((url, init) => {
    if (url.pathname === '/open-apis/docx/v1/documents' && init.method === 'POST') {
      creates++; mutations++; return json({ document: { document_id: 'testDoc', title: 'fixture', revision_id: 1 } });
    }
    if (init.method === 'GET') return json({ document: { document_id: 'testDoc', title: 'fixture', revision_id: revision } });
    mutations++; return json({});
  }), 0));
  return { ...env, store, documents, operations: new Operations(env.config, manager, documents),
    counts: () => ({ creates, mutations }), changeRevision: () => { revision++; } };
}
it('blocks all mutations without an exact local approval and consumes them once', async () => {
  const f = await fixture();
  try {
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture' });
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'APPROVAL_REQUIRED' });
    expect(f.counts().mutations).toBe(0);
    await f.operations.approve(draft.operationId);
    const result = await f.operations.commit(draft.operationId);
    expect(result).toMatchObject({ documentId: 'testDoc' }); expect(f.counts().creates).toBe(1);
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'OPERATION_NOT_FOUND' });
    const receipts = await readdir(join(f.config.stateDir, 'test', 'operations'));
    expect(receipts).toEqual([draft.operationId + '.json.receipt']);
  } finally { await f.cleanup(); }
});
it('rejects write-disabled configuration, missing grants and stale revisions', async () => {
  const disabled = await fixture(false); const f = await fixture();
  try {
    await expect(disabled.operations.prepare({ type: 'create', title: 'fixture' })).rejects.toMatchObject({ kind: 'WRITES_DISABLED' });
    f.store.value!.scopes = ['docx:document:create'];
    await expect(f.operations.prepare({ type: 'create', title: 'fixture', content: [{ type: 'paragraph', text: 'x' }] })).rejects.toMatchObject({ kind: 'MISSING_SCOPE' });
    f.store.value = session();
    const draft = await f.operations.prepare({ type: 'delete', documentId: 'testDoc', revision: 1 });
    await f.operations.approve(draft.operationId); f.changeRevision();
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'CONFLICT' });
    expect(f.counts().mutations).toBe(0);
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'OPERATION_NOT_FOUND' });
  } finally { await disabled.cleanup(); await f.cleanup(); }
});
it('rejects forged approval signatures and session replacement', async () => {
  const f = await fixture();
  try {
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture' });
    const path = join(f.config.stateDir, 'test', 'operations', draft.operationId + '.json');
    const contents = JSON.parse(await readFile(path, 'utf8')); contents.signature = '0'.repeat(64);
    await writeFile(path, JSON.stringify(contents));
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'APPROVAL_REQUIRED' });
    await f.operations.approve(draft.operationId);
    f.store.value = session();
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'IDENTITY_MISMATCH' });
    expect(f.counts().mutations).toBe(0);
  } finally { await f.cleanup(); }
});
it('expires drafts and rejects payload tampering', async () => {
  const f = await fixture();
  try {
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture' });
    const path = join(f.config.stateDir, 'test', 'operations', draft.operationId + '.json');
    const contents = JSON.parse(await readFile(path, 'utf8')); contents.payload.title = 'changed';
    await writeFile(path, JSON.stringify(contents));
    await expect(f.operations.approve(draft.operationId)).rejects.toMatchObject({ kind: 'INVALID_OPERATION' });
  } finally { await f.cleanup(); }
});
it('expires an otherwise valid draft without performing a write', async () => {
  const f = await fixture();
  try {
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(draft.expiresAt + 1);
    try { await expect(f.operations.inspect(draft.operationId)).rejects.toMatchObject({ kind: 'OPERATION_EXPIRED' }); }
    finally { clock.mockRestore(); }
    expect(f.counts().mutations).toBe(0);
  } finally { await f.cleanup(); }
});
it('rejects an approved payload change even if its unkeyed hash was recomputed', async () => {
  const f = await fixture();
  try {
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture' });
    await f.operations.approve(draft.operationId);
    const path = join(f.config.stateDir, 'test', 'operations', draft.operationId + '.json');
    const value = JSON.parse(await readFile(path, 'utf8')); value.payload.title = 'tampered';
    const unsigned = { id: value.id, owner: value.owner, createdAt: value.createdAt, expiresAt: value.expiresAt, payload: value.payload, title: value.title };
    value.hash = fingerprint(unsigned); await writeFile(path, JSON.stringify(value));
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'APPROVAL_REQUIRED' });
  } finally { await f.cleanup(); }
});
it('reports partial creation without silently deleting or duplicating the created document', async () => {
  const env = await setup(); const manager = new SessionManager(new MemoryStore(), env.config); let created = 0;
  const docs = new Documents(new FeishuHttp(() => manager.token(), fakeFetch((url, init) => {
    if (url.pathname.endsWith('/documents')) { created++; return json({ document: { document_id: 'partialDoc', title: 'fixture', revision_id: 1 } }); }
    expect(init.method).toBe('POST'); return json({}, 1770003, 400);
  }), 0));
  try {
    await expect(docs.create('fixture', undefined, [{ type: 'paragraph', text: 'x' }])).rejects.toMatchObject({ kind: 'PARTIAL_WRITE', details: { documentId: 'partialDoc' } });
    expect(created).toBe(1);
  } finally { await env.cleanup(); }
});
