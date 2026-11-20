import { z } from 'zod';
import { AppError, type Settings, withLock } from './core.js';

export const sessionSchema = z.object({
  version: z.literal(1), region: z.literal('feishu.cn'), profile: z.string(),
  appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), appSecret: z.string().min(1).max(512),
  userId: z.string().min(1), tenantId: z.string().min(1), loginId: z.string().uuid(),
  approvalKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  // Read legacy PKCE credential records so upgrades do not discard existing logins.
  // New logins always use confidential-client authentication.
  authMode: z.enum(['pkce', 'confidential']), accessToken: z.string().min(1).max(32768),
  expiresAt: z.number().int().positive(), scopes: z.array(z.string()).max(200),
  refreshToken: z.string().max(32768).optional(), refreshExpiresAt: z.number().optional(),
  refreshState: z.enum(['active', 'uncertain']).default('active'),
}).strict();
export type Session = z.infer<typeof sessionSchema>;
export interface CredentialStore { load(): Promise<Session | null>; save(session: Session): Promise<void>; delete(): Promise<void> }

export class KeychainStore implements CredentialStore {
  constructor(private readonly profile: string) {}
  private async entry() {
    try {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      return new AsyncEntry('better-feishu-mcp.feishu.cn', this.profile, { linux: { store: 'secret-service' } });
    } catch { throw new AppError('KEYCHAIN_UNAVAILABLE', 'OS credential storage is unavailable. No plaintext fallback is permitted.'); }
  }
  async load() {
    try {
      const raw = await (await this.entry()).getPassword();
      if (raw === null) return null;
      const session = sessionSchema.parse(JSON.parse(raw));
      if (session.profile !== this.profile) throw new Error('Profile mismatch');
      return session;
    } catch { throw new AppError('KEYCHAIN_UNAVAILABLE', 'Cannot read a valid credential record from the OS keychain. Unlock it or log in again.'); }
  }
  async save(session: Session) {
    const valid = sessionSchema.parse(session);
    if (valid.profile !== this.profile) throw new AppError('IDENTITY_MISMATCH', 'Credential profile mismatch.');
    try { await (await this.entry()).setPassword(JSON.stringify(valid)); }
    catch { throw new AppError('KEYCHAIN_UNAVAILABLE', 'OS keychain write failed; credentials were not written to a file.'); }
  }
  async delete() {
    try { await (await this.entry()).deleteCredential(); }
    catch { throw new AppError('KEYCHAIN_UNAVAILABLE', 'OS keychain deletion failed. Local logout is not complete.'); }
  }
}
export class SessionManager {
  constructor(readonly store: CredentialStore, readonly config: Settings,
    private readonly refresh?: (session: Session) => Promise<Session>) {}
  async current(): Promise<Session> {
    const session = await this.store.load();
    if (!session) throw new AppError('LOGIN_REQUIRED', 'Run better-feishu-mcp login.');
    return session;
  }
  async token(): Promise<Session> {
    return withLock(this.config, 'credentials', async () => {
      const session = await this.current();
      if (session.refreshState === 'uncertain') throw new AppError('LOGIN_REQUIRED', 'A prior refresh had an uncertain outcome. Log in again; do not retry a single-use refresh token.');
      if (session.expiresAt > Date.now() + 30_000) return session;
      if (!session.refreshToken || !this.refresh || !session.refreshExpiresAt || session.refreshExpiresAt <= Date.now()) {
        throw new AppError('LOGIN_REQUIRED', 'User access expired and no usable refresh credentials are available. Run better-feishu-mcp login; enable offline_access in Feishu for persistent renewal.');
      }
      // Atomic keychain record update before the network call: crash/timeout fails closed.
      await this.store.save({ ...session, refreshState: 'uncertain' });
      const next = sessionSchema.parse(await this.refresh(session));
      if (next.appId !== session.appId || next.userId !== session.userId || next.tenantId !== session.tenantId || next.loginId !== session.loginId) {
        throw new AppError('IDENTITY_MISMATCH', 'Refresh changed the bound user/app/tenant. Log in explicitly.');
      }
      await this.store.save(next);
      return next;
    });
  }
  async logout() { await withLock(this.config, 'credentials', () => this.store.delete()); }
}
