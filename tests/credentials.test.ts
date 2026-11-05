import { it, expect } from 'vitest';
import { SessionManager } from '../src/credentials.js';
import { MemoryStore, session, setup } from './helpers.js';

it('requires login with no session or expired non-refresh session', async () => {
  const { config, cleanup } = await setup();
  try {
    await expect(new SessionManager(new MemoryStore(null), config).token()).rejects.toMatchObject({ kind: 'LOGIN_REQUIRED' });
    await expect(new SessionManager(new MemoryStore(session({ expiresAt: 1 })), config).token()).rejects.toMatchObject({ kind: 'LOGIN_REQUIRED' });
  } finally { await cleanup(); }
});
it('serializes refresh across managers and atomically saves rotation', async () => {
  const { config, cleanup } = await setup();
  const store = new MemoryStore(session({ expiresAt: 1, refreshToken: 'old', refreshExpiresAt: Date.now() + 100000 }));
  let count = 0;
  const refresh = async (old: ReturnType<typeof session>) => {
    count++; expect(store.value?.refreshState).toBe('uncertain');
    await new Promise(r => setTimeout(r, 60));
    return { ...old, expiresAt: Date.now() + 100000, refreshToken: 'new', refreshState: 'active' as const };
  };
  try {
    const a = new SessionManager(store, config, refresh); const b = new SessionManager(store, config, refresh);
    const values = await Promise.all([a.token(), b.token()]);
    expect(count).toBe(1); expect(values.every(v => v.refreshToken === 'new')).toBe(true);
  } finally { await cleanup(); }
});
it('never replays a refresh with an uncertain outcome', async () => {
  const { config, cleanup } = await setup();
  const store = new MemoryStore(session({ expiresAt: 1, refreshToken: 'old', refreshExpiresAt: Date.now() + 100000 }));
  let count = 0;
  const manager = new SessionManager(store, config, async () => { count++; throw new Error('network timeout'); });
  try {
    await expect(manager.token()).rejects.toThrow();
    await expect(manager.token()).rejects.toMatchObject({ kind: 'LOGIN_REQUIRED' });
    expect(count).toBe(1); expect(store.value?.refreshState).toBe('uncertain');
  } finally { await cleanup(); }
});
it('rejects refresh identity changes and honors logout', async () => {
  const { config, cleanup } = await setup();
  const store = new MemoryStore(session({ expiresAt: 1, refreshToken: 'old', refreshExpiresAt: Date.now() + 100000 }));
  const manager = new SessionManager(store, config, async old => ({ ...old, userId: 'different', refreshState: 'active' }));
  try {
    await expect(manager.token()).rejects.toMatchObject({ kind: 'IDENTITY_MISMATCH' });
    await manager.logout(); expect(await store.load()).toBe(null);
  } finally { await cleanup(); }
});
