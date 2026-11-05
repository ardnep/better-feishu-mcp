import { z } from 'zod';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, docSchema, idSchema, privateDir, requireScopes, type Settings, withLock } from './core.js';
import { type Session, SessionManager } from './credentials.js';
import { contentSchema, Documents, fingerprint } from './services.js';

export const mutationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), title: z.string().min(1).max(800), folderId: idSchema.optional(), content: contentSchema.optional() }).strict(),
  z.object({ type: z.literal('update'), documentId: docSchema, revision: z.number().int().positive(),
    change: z.discriminatedUnion('type', [
      z.object({ type: z.literal('append'), content: contentSchema }).strict(),
      z.object({ type: z.literal('replace_text'), blockId: idSchema, text: z.string().min(1).max(10_000) }).strict(),
    ]) }).strict(),
  z.object({ type: z.literal('delete'), documentId: docSchema, revision: z.number().int().positive() }).strict(),
]);
export type Mutation = z.infer<typeof mutationSchema>;
const operationId = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const draftSchema = z.object({ id: operationId, owner: z.string().length(64), createdAt: z.number(), expiresAt: z.number(),
  payload: mutationSchema, title: z.string().max(800), hash: z.string().length(64), signature: z.string().optional() }).strict();
type Draft = z.infer<typeof draftSchema>;
function owner(session: Session) { return fingerprint([session.region, session.appId, session.tenantId, session.userId, session.loginId]); }
function unsigned(draft: Draft) { return { id: draft.id, owner: draft.owner, createdAt: draft.createdAt, expiresAt: draft.expiresAt, payload: draft.payload, title: draft.title }; }
function signature(draft: Draft, session: Session) { return createHmac('sha256', session.approvalKey).update(JSON.stringify(unsigned(draft))).digest('hex'); }
function same(a: string, b: string) { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function checkScopes(session: Session, payload: Mutation) {
  if (payload.type === 'create') requireScopes(session.scopes, [
    ['docx:document:create', 'docx:document'], ...(payload.content ? [['docx:document:write_only', 'docx:document']] : []),
  ]);
  else requireScopes(session.scopes, [['docx:document:readonly', 'docx:document'], payload.type === 'update'
    ? ['docx:document:write_only', 'docx:document'] : ['space:document:delete', 'drive:drive']]);
}
export class Operations {
  constructor(private readonly config: Settings, private readonly sessions: SessionManager, private readonly documents: Documents) {}
  private root() { return join(this.config.stateDir, this.config.profile, 'operations'); }
  private path(id: string) { return join(this.root(), operationId.parse(id) + '.json'); }
  private assertEnabled() { if (!this.config.writes) throw new AppError('WRITES_DISABLED', 'Restart the server with BETTER_FEISHU_MCP_ENABLE_WRITES=1 to enable document mutations.'); }
  // Direct tools use the existing user login and write opt-in, not local draft approval.
  async execute(input: Mutation, signal?: AbortSignal) {
    this.assertEnabled();
    const payload = mutationSchema.parse(input);
    signal?.throwIfAborted();
    checkScopes(await this.sessions.token(), payload);
    const target = payload.type === 'create' ? `folder-${payload.folderId ?? 'root'}` : `doc-${payload.documentId}`;
    return withLock(this.config, target, async () => {
      if (payload.type === 'create') return this.documents.create(payload.title, payload.folderId, payload.content, signal);
      if (payload.type === 'update') return this.documents.update(payload.documentId, payload.revision, payload.change, signal);
      return this.documents.delete(payload.documentId, payload.revision, signal);
    });
  }
  private async load(id: string): Promise<Draft> {
    let text: string;
    try {
      const path = this.path(id); const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200_000) throw new Error('Unsafe operation file');
      text = await readFile(path, 'utf8');
    } catch { throw new AppError('OPERATION_NOT_FOUND', 'Unknown or already consumed operation. Writes are never replayed automatically.'); }
    const draft = draftSchema.parse(JSON.parse(text));
    if (draft.id !== id || draft.hash !== fingerprint(unsigned(draft))) throw new AppError('INVALID_OPERATION', 'Prepared operation was modified.');
    if (draft.expiresAt <= Date.now()) { await rm(this.path(id), { force: true }); throw new AppError('OPERATION_EXPIRED', 'Prepared operation expired. Prepare it again.'); }
    return draft;
  }
  private async persist(draft: Draft) {
    const temporary = this.path(draft.id) + '.' + randomBytes(8).toString('hex') + '.tmp';
    await writeFile(temporary, JSON.stringify(draft), { mode: 0o600, flag: 'wx' });
    await rename(temporary, this.path(draft.id));
  }
  async prepare(input: Mutation, signal?: AbortSignal) {
    this.assertEnabled();
    const payload = mutationSchema.parse(input);
    const session = await this.sessions.token();
    checkScopes(session, payload);
    let title = payload.type === 'create' ? payload.title : '';
    if (payload.type !== 'create') {
      const document = await this.documents.metadata(payload.documentId, signal); title = document.title;
      if (document.revision_id !== payload.revision) throw new AppError('CONFLICT', 'Expected revision does not match the current document.');
    }
    return withLock(this.config, 'drafts', async () => {
      await privateDir(this.root());
      // Expired content is removed; keep at most 64 pending drafts per profile.
      const pending = (await readdir(this.root())).filter(name => /^[A-Za-z0-9_-]{32}\.json$/.test(name));
      let active = 0;
      for (const name of pending) {
        try { await this.load(name.slice(0, -5)); active++; } catch (error) { if (!(error instanceof AppError) || error.kind !== 'OPERATION_EXPIRED') throw error; }
      }
      if (active >= 64) throw new AppError('OPERATION_LIMIT', 'Too many pending drafts. Review or let them expire.');
      const base = { id: randomBytes(24).toString('base64url'), owner: owner(session), createdAt: Date.now(), expiresAt: Date.now() + 600_000, payload, title };
      const draft: Draft = { ...base, hash: fingerprint(base) };
      await writeFile(this.path(draft.id), JSON.stringify(draft), { mode: 0o600, flag: 'wx' });
      return { operationId: draft.id, expiresAt: draft.expiresAt, preview: { title, ...payload },
        approval: { command: process.execPath, args: [fileURLToPath(new URL('./cli.js', import.meta.url)), 'approve', draft.id, '--profile', this.config.profile],
          env: { BETTER_FEISHU_MCP_STATE_DIR: this.config.stateDir } },
        note: 'A human must review this exact preview in a trusted local terminal. The MCP cannot approve its own write.' };
    });
  }
  async inspect(id: string) {
    const draft = await this.load(id); const session = await this.sessions.current();
    if (draft.owner !== owner(session)) throw new AppError('IDENTITY_MISMATCH', 'Operation belongs to another login.');
    return { operationId: id, expiresAt: draft.expiresAt, title: draft.title, payload: draft.payload, approved: !!draft.signature };
  }
  // Called only by the interactive CLI after local human review; never registered as an MCP tool.
  async approve(id: string) {
    return withLock(this.config, 'op-' + operationId.parse(id), async () => {
      const draft = await this.load(id); const session = await this.sessions.current();
      if (draft.owner !== owner(session)) throw new AppError('IDENTITY_MISMATCH', 'Operation belongs to another login.');
      await this.persist({ ...draft, signature: signature(draft, session) });
    });
  }
  async commit(id: string, signal?: AbortSignal) {
    this.assertEnabled();
    return withLock(this.config, 'op-' + operationId.parse(id), async () => {
      signal?.throwIfAborted();
      const draft = await this.load(id); const session = await this.sessions.token();
      checkScopes(session, draft.payload);
      if (draft.owner !== owner(session)) throw new AppError('IDENTITY_MISMATCH', 'Operation belongs to another login.');
      if (!draft.signature || !same(draft.signature, signature(draft, session))) throw new AppError('APPROVAL_REQUIRED', 'Approve this exact operation in a trusted local terminal first.');
      const consumed = this.path(id) + '.consumed';
      await rename(this.path(id), consumed); // Claim before any network call; cannot replay after a crash.
      const payload = draft.payload;
      try {
        const perform = async () => {
          if (payload.type === 'create') return this.documents.create(payload.title, payload.folderId, payload.content, signal);
          if (payload.type === 'update') return this.documents.update(payload.documentId, payload.revision, payload.change, signal);
          return this.documents.delete(payload.documentId, payload.revision, signal);
        };
        const target = payload.type === 'create' ? `folder-${payload.folderId ?? 'root'}` : `doc-${payload.documentId}`;
        const result = await withLock(this.config, target, perform);
        await writeFile(this.path(id) + '.receipt', JSON.stringify({ id, status: 'succeeded', completedAt: Date.now(), result }), { mode: 0o600, flag: 'wx' });
        await rm(consumed); return result;
      } catch (error) {
        await writeFile(this.path(id) + '.receipt', JSON.stringify({ id, status: 'failed_or_uncertain', completedAt: Date.now(),
          kind: error instanceof AppError ? error.kind : 'UNKNOWN', ...(error instanceof AppError && error.kind === 'PARTIAL_WRITE' ? error.details : {}) }), { mode: 0o600, flag: 'wx' });
        await rm(consumed);
        throw error;
      }
    });
  }
}
