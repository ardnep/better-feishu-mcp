import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, lstat, rm, rmdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export class AppError extends Error {
  constructor(public readonly kind: string, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}
export function safeError(error: unknown) {
  if (error instanceof AppError) return { kind: error.kind, message: error.message, ...error.details };
  if (error instanceof z.ZodError) return { kind: 'INVALID_DATA', message: 'Input or provider response did not match the expected schema.', fields: error.issues.map(i => i.path.join('.')) };
  return { kind: 'INTERNAL_ERROR', message: 'Operation failed. No private upstream response has been logged.' };
}
export const profileSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/);
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const docSchema = z.string().max(400).transform((value, ctx) => {
  if (idSchema.safeParse(value).success) return value;
  try {
    const url = new URL(value);
    const match = /^\/docx\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    if (url.protocol === 'https:' && url.hostname.endsWith('.feishu.cn') && !url.username && !url.password && !url.port && match?.[1] && idSchema.safeParse(match[1]).success) return match[1];
  } catch { /* only explicit Docx links or IDs */ }
  ctx.addIssue({ code: 'custom', message: 'Provide a modern Docx ID or https://<tenant>.feishu.cn/docx/<id> link. Wiki/legacy links are not supported.' });
  return z.NEVER;
});
export const BASE_SCOPES = [
  'search:message', 'im:chat:read', 'im:message:readonly',
  'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user',
  'docx:document:readonly', 'docx:document:create', 'docx:document:write_only', 'space:document:delete',
] as const;
export type AuthMode = 'pkce' | 'confidential';
export type Settings = Readonly<{ profile: string; stateDir: string; writes: boolean }>;
export function settings(env: NodeJS.ProcessEnv = process.env): Settings {
  return Object.freeze({ profile: profileSchema.parse(env.BETTER_FEISHU_MCP_PROFILE ?? 'default'),
    stateDir: env.BETTER_FEISHU_MCP_STATE_DIR ?? join(homedir(), '.local', 'state', 'better-feishu-mcp'),
    writes: env.BETTER_FEISHU_MCP_ENABLE_WRITES === '1' });
}
export async function privateDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new AppError('UNSAFE_STATE_DIRECTORY', 'State directory must be a private directory (mode 0700), not a symlink.');
  }
}
export async function withLock<T>(config: Settings, name: string, work: () => Promise<T>): Promise<T> {
  idSchema.parse(name);
  const root = join(config.stateDir, config.profile);
  await privateDir(root);
  const lock = join(root, name + '.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new AppError('BUSY', 'Another operation holds a local lock. If a process crashed, inspect the state directory before removing its lock.');
      await sleep(50);
    }
  }
  try { await writeFile(join(lock, 'owner'), String(process.pid), { mode: 0o600 }); return await work(); }
  finally { await rm(join(lock, 'owner'), { force: true }); await rmdir(lock); }
}
export function requireScopes(actual: readonly string[], required: readonly (string | readonly string[])[]) {
  const missing = required.filter(group => !(typeof group === 'string' ? [group] : group).some(s => actual.includes(s)));
  if (missing.length) throw new AppError('MISSING_SCOPE', 'User authorization lacks required scopes. Explicitly reauthorize; identity fallback is forbidden.', { required: missing });
}
