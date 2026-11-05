import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { BASE_SCOPES, type Settings } from '../src/core.js';
import type { CredentialStore, Session } from '../src/credentials.js';
import type { Fetch } from '../src/http.js';

export function session(overrides: Partial<Session> = {}): Session {
  return { version: 1, region: 'feishu.cn', profile: 'test', appId: 'cli_synthetic', appSecret: 'synthetic-secret-never-live',
    accessToken: 'synthetic-user-token-never-live', expiresAt: Date.now() + 3_600_000, scopes: [...BASE_SCOPES],
    userId: 'ou_synthetic', tenantId: 'tenant_synthetic', loginId: randomUUID(), approvalKey: randomBytes(32).toString('base64url'),
    authMode: 'confidential', refreshState: 'active', ...overrides };
}
export class MemoryStore implements CredentialStore {
  constructor(public value: Session | null = session()) {}
  async load() { return this.value ? structuredClone(this.value) : null; }
  async save(value: Session) { this.value = structuredClone(value); }
  async delete() { this.value = null; }
}
export async function setup(writes = true) {
  const base = join(tmpdir(), 'opencode'); await mkdir(base, { recursive: true });
  const stateDir = await realpath(await mkdtemp(join(base, 'better-feishu-tests-')));
  const config: Settings = { profile: 'test', stateDir, writes };
  return { config, cleanup: () => rm(stateDir, { recursive: true, force: true }) };
}
export function json(data: unknown, code = 0, status = 200) { return new Response(JSON.stringify({ code, data }), { status, headers: { 'content-type': 'application/json' } }); }
export function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(typeof input === 'string' || input instanceof URL ? input : input.url), init ?? {})) as Fetch;
}
