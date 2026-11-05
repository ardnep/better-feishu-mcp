import { it, expect } from 'vitest';
import { writeFile, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '../src/credentials.js';
import { FeishuHttp } from '../src/http.js';
import { Documents, contentSchema, fingerprint } from '../src/services.js';
import { Operations } from '../src/operations.js';
import { MemoryStore, fakeFetch, json, session, setup } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture(failAt?: 'upload' | 'attach' | 'mapping') {
  const env = await setup();
  const store = new MemoryStore(session({ scopes: [...session().scopes, 'docs:document.media:upload'] }));
  const sessions = new SessionManager(store, env.config);
  const calls: { path: string; method: string; body: unknown }[] = [];
  let patchRevision = 2;
  const docs = new Documents(new FeishuHttp(() => sessions.token(), fakeFetch(async (url, init) => {
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method: init.method!, body });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-user-token-never-live');
    expect(init.redirect).toBe('error');
    if (url.pathname === '/open-apis/docx/v1/documents') return json({ document: { document_id: 'imageDoc', title: 'fixture', revision_id: 1 } });
    if (init.method === 'GET') return json({ document: { document_id: 'imageDoc', title: 'fixture', revision_id: 1 } });
    if (url.pathname.endsWith('/children')) {
      if (failAt === 'mapping') return json({ document_revision_id: 2, children: [] });
      return json({ document_revision_id: 2, children: body.children.map((b: { block_type: number }, i: number) => ({ block_id: 'block' + i, block_type: b.block_type })) });
    }
    if (url.pathname.endsWith('/medias/upload_all')) {
      expect(body).toBeInstanceOf(FormData);
      expect(new Headers(init.headers).has('content-type')).toBe(false);
      expect(body.get('parent_type')).toBe('docx_image');
      expect(['block1', 'block3']).toContain(body.get('parent_node'));
      expect(JSON.parse(String(body.get('extra')))).toEqual({ drive_route_token: 'imageDoc' });
      expect(body.get('size')).toBe(String(PNG.length));
      expect(Buffer.from(await (body.get('file') as Blob).arrayBuffer())).toEqual(PNG);
      if (failAt === 'upload') throw new Error('synthetic ambiguous upload; never replay');
      return json({ file_token: 'mediaFixture' });
    }
    if (failAt === 'attach') return json({}, 1770003, 400);
    expect(body).toEqual({ replace_image: { token: 'mediaFixture', width: 1, height: 1, caption: { content: 'Example screenshot' } } });
    expect(url.searchParams.get('document_revision_id')).toBe(String(patchRevision));
    return json({ document_revision_id: ++patchRevision });
  }), 0));
  const image = join(env.config.stateDir, 'screenshot.png'); await writeFile(image, PNG);
  const content = () => contentSchema.parse([{ type: 'heading', text: 'Example' }, { type: 'image', path: image, caption: 'Example screenshot' }, { type: 'paragraph', text: 'After the image' }]);
  return { ...env, store, calls, image, content, operations: new Operations(env.config, sessions, docs) };
}

it('creates an interleaved image only after exact approval, with proper upload binding and no replay', async () => {
  const f = await fixture();
  try {
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() });
    expect(draft.preview).toMatchObject({ images: [{ path: f.image, mimeType: 'image/png', sizeBytes: PNG.length, width: 1, height: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    expect(f.calls).toHaveLength(0);
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'APPROVAL_REQUIRED' });
    await f.operations.approve(draft.operationId);
    await expect(f.operations.commit(draft.operationId)).resolves.toMatchObject({ documentId: 'imageDoc' });
    expect(f.calls.map(c => c.method)).toEqual(['POST', 'POST', 'POST', 'PATCH']);
    expect((f.calls[1]!.body as any).children.map((b: any) => b.block_type)).toEqual([3, 27, 2]);
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'OPERATION_NOT_FOUND' });
  } finally { await f.cleanup(); }
});
it.each(['create', 'append'] as const)('supports direct image %s without a legacy approval draft', async mode => {
  const f = await fixture();
  try {
    const result = mode === 'create'
      ? await f.operations.execute({ type: 'create', title: 'fixture', content: f.content() })
      : await f.operations.execute({ type: 'update', documentId: 'imageDoc', revision: 1, change: { type: 'append', content: f.content() } });
    expect(result).toMatchObject({ documentId: 'imageDoc' });
    expect(f.calls.filter(c => c.path.endsWith('/medias/upload_all'))).toHaveLength(1);
    expect(f.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
    await expect(readFile(join(f.config.stateDir, 'test', 'operations'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.cleanup(); }
});
it('rejects unsafe direct images and missing media scope before any mutation', async () => {
  const f = await fixture();
  try {
    f.store.value!.scopes = [...session().scopes];
    await expect(f.operations.execute({ type: 'create', title: 'fixture', content: f.content() })).rejects.toMatchObject({ kind: 'MISSING_SCOPE' });
    f.store.value!.scopes.push('docs:document.media:upload');
    await writeFile(f.image, 'not an image');
    await expect(f.operations.execute({ type: 'create', title: 'fixture', content: f.content() })).rejects.toMatchObject({ kind: 'UNSUPPORTED_IMAGE' });
    expect(f.calls).toHaveLength(0);
  } finally { await f.cleanup(); }
});

it('refuses missing media scope and unsafe or changed images before any write', async () => {
  const f = await fixture();
  try {
    f.store.value!.scopes = [...session().scopes];
    await expect(f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() })).rejects.toMatchObject({ kind: 'MISSING_SCOPE' });
    f.store.value!.scopes.push('docs:document.media:upload');
    const link = join(f.config.stateDir, 'linked.png'); await symlink(f.image, link);
    await expect(f.operations.prepare({ type: 'create', title: 'fixture', content: [{ type: 'image', path: link }] })).rejects.toMatchObject({ kind: 'UNSAFE_IMAGE' });
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() });
    await f.operations.approve(draft.operationId);
    await writeFile(f.image, Buffer.concat([PNG, Buffer.from('changed')]));
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'IMAGE_CHANGED' });
    expect(f.calls).toHaveLength(0);
  } finally { await f.cleanup(); }
});

it('rejects unsupported raster content, excessive image counts, and oversized files', async () => {
  const f = await fixture();
  try {
    await writeFile(f.image, '<svg>not an approved raster image</svg>');
    await expect(f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() })).rejects.toMatchObject({ kind: 'UNSUPPORTED_IMAGE' });
    await writeFile(f.image, Buffer.alloc(5_000_001));
    await expect(f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() })).rejects.toMatchObject({ kind: 'IMAGE_TOO_LARGE' });
    expect(() => contentSchema.parse(Array.from({ length: 11 }, () => ({ type: 'image', path: f.image })))).toThrow();
    expect(() => contentSchema.parse([{ type: 'image', path: 'https://example.com/screenshot.png' }])).toThrow();
    expect(f.calls).toHaveLength(0);
  } finally { await f.cleanup(); }
});

it.each(['upload', 'attach'] as const)('reports recoverable partial document IDs after %s failure without retries', async failAt => {
  const f = await fixture(failAt);
  try {
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() });
    await f.operations.approve(draft.operationId);
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'PARTIAL_WRITE', details: { documentId: 'imageDoc', imageBlockId: 'block1', stage: failAt } });
    expect(f.calls.filter(c => c.path.endsWith('/medias/upload_all'))).toHaveLength(1);
    const receipt = JSON.parse(await readFile(join(f.config.stateDir, 'test', 'operations', draft.operationId + '.json.receipt'), 'utf8'));
    expect(receipt).toMatchObject({ status: 'failed_or_uncertain', documentId: 'imageDoc', imageBlockId: 'block1' });
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'OPERATION_NOT_FOUND' });
  } finally { await f.cleanup(); }
});

it('appends an image without replacing unrelated blocks', async () => {
  const f = await fixture();
  try {
    const draft = await f.operations.prepare({ type: 'update', documentId: 'imageDoc', revision: 1, change: { type: 'append', content: f.content() } });
    await f.operations.approve(draft.operationId);
    await expect(f.operations.commit(draft.operationId)).resolves.toMatchObject({ changed: true });
    expect(f.calls.filter(c => c.method !== 'GET').map(c => c.path)).toEqual([
      '/open-apis/docx/v1/documents/imageDoc/blocks/imageDoc/children', '/open-apis/drive/v1/medias/upload_all',
      '/open-apis/docx/v1/documents/imageDoc/blocks/block1',
    ]);
  } finally { await f.cleanup(); }
});

it('keeps multiple images in order and advances the patch revision for each one', async () => {
  const f = await fixture();
  try {
    const content = [...f.content(), { type: 'image' as const, path: f.image, caption: 'Example screenshot' }];
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture', content });
    await f.operations.approve(draft.operationId); await f.operations.commit(draft.operationId);
    const uploads = f.calls.filter(c => c.body instanceof FormData);
    expect(uploads.map(c => (c.body as FormData).get('parent_node'))).toEqual(['block1', 'block3']);
  } finally { await f.cleanup(); }
});

it('refuses a forged image manifest even when the unkeyed draft hash is recomputed', async () => {
  const f = await fixture();
  try {
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() });
    await f.operations.approve(draft.operationId);
    const path = join(f.config.stateDir, 'test', 'operations', draft.operationId + '.json');
    const value = JSON.parse(await readFile(path, 'utf8')); value.images[0].sha256 = '0'.repeat(64);
    const { hash: _hash, signature: _signature, ...unsigned } = value;
    value.hash = fingerprint(unsigned); await writeFile(path, JSON.stringify(value));
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'APPROVAL_REQUIRED' });
    expect(f.calls).toHaveLength(0);
  } finally { await f.cleanup(); }
});

it('does not guess an image upload target when the created-block mapping is missing', async () => {
  const f = await fixture('mapping');
  try {
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() });
    await f.operations.approve(draft.operationId);
    await expect(f.operations.commit(draft.operationId)).rejects.toMatchObject({ kind: 'PARTIAL_WRITE', details: { documentId: 'imageDoc', stage: 'blocks' } });
    expect(f.calls.filter(c => c.body instanceof FormData)).toHaveLength(0);
  } finally { await f.cleanup(); }
});

it('sniffs JPEG dimensions instead of trusting the filename and rejects malformed headers', async () => {
  const f = await fixture();
  try {
    // A minimal SOF header exercises dimension parsing, not full image decoding.
    await writeFile(f.image, Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 2, 1, 1, 0x11, 0, 0xff, 0xd9]));
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() });
    expect(draft.preview.images?.[0]).toMatchObject({ mimeType: 'image/jpeg', fileName: 'screenshot.jpg', width: 2, height: 1 });
    await writeFile(f.image, Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11]));
    await expect(f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() })).rejects.toMatchObject({ kind: 'UNSUPPORTED_IMAGE' });
    const invalid = Buffer.from(PNG); invalid.writeUInt32BE(0, 16); await writeFile(f.image, invalid);
    await expect(f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() })).rejects.toMatchObject({ kind: 'UNSUPPORTED_IMAGE' });
  } finally { await f.cleanup(); }
});

it('enforces the aggregate byte limit and rechecks images at approval time too', async () => {
  const f = await fixture();
  try {
    const large = Buffer.alloc(5_000_000); PNG.copy(large); await writeFile(f.image, large);
    await expect(f.operations.prepare({ type: 'create', title: 'fixture', content: Array.from({ length: 5 }, () => ({ type: 'image', path: f.image })) })).rejects.toMatchObject({ kind: 'IMAGE_TOO_LARGE' });
    await writeFile(f.image, PNG);
    const draft = await f.operations.prepare({ type: 'create', title: 'fixture', content: f.content() });
    await writeFile(f.image, Buffer.concat([PNG, Buffer.from('changed')]));
    await expect(f.operations.approve(draft.operationId)).rejects.toMatchObject({ kind: 'IMAGE_CHANGED' });
    expect((await f.operations.inspect(draft.operationId)).approved).toBe(false);
    expect(f.calls).toHaveLength(0);
  } finally { await f.cleanup(); }
});
