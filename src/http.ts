import { z } from 'zod';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, requireScopes } from './core.js';
import type { Session } from './credentials.js';

export type Fetch = typeof globalThis.fetch;
export async function boundedJson(response: Response, maximum = 2_000_000): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('INVALID_RESPONSE', 'Provider returned no JSON body.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new AppError('RESPONSE_TOO_LARGE', 'Provider response exceeded the byte limit. Request a smaller page.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_RESPONSE', 'Provider returned invalid or interrupted JSON.');
  } finally { reader.releaseLock(); }
}
const envelope = z.object({ code: z.number(), data: z.unknown().optional(), error: z.object({
  log_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  permission_violations: z.array(z.object({ subject: z.string().regex(/^[a-z0-9_.:-]+$/), type: z.string() })).optional(),
}).optional() });
export class FeishuHttp {
  private queue: Promise<void> = Promise.resolve();
  private lastRequest = 0;
  constructor(private readonly getSession: () => Promise<Session>, private readonly fetcher: Fetch = fetch,
    private readonly spacingMs = 400) {}
  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, schema: z.ZodType<T>,
    options: { body?: unknown; scopes?: readonly (string | readonly string[])[]; signal?: AbortSignal; safeRead?: boolean } = {}): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\]/.test(path)) throw new AppError('INVALID_ENDPOINT', 'Only fixed Feishu API paths are permitted.');
    const url = new URL('https://open.feishu.cn/open-apis' + path);
    if (url.origin !== 'https://open.feishu.cn' || !url.pathname.startsWith('/open-apis/')) throw new AppError('INVALID_ENDPOINT', 'Invalid API origin.');
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
    const attempts = method === 'GET' || options.safeRead ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal.throwIfAborted();
      const session = await this.getSession();
      requireScopes(session.scopes, options.scopes ?? []);
      const slot = this.queue.then(async () => {
        await sleep(Math.max(0, this.lastRequest + this.spacingMs - Date.now()), undefined, { signal });
        this.lastRequest = Date.now();
      });
      this.queue = slot.catch(() => {}); await slot;
      let response: Response;
      try {
        response = await this.fetcher(url, { method, redirect: 'error', signal,
          headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
      } catch {
        throw new AppError(signal.aborted ? 'CANCELLED' : 'NETWORK_ERROR', method === 'GET' || options.safeRead
          ? 'Read request failed or was cancelled.' : 'Write outcome may be unknown. Inspect the target before retrying.');
      }
      const parsed = envelope.safeParse(await boundedJson(response));
      if (!parsed.success) throw new AppError('INVALID_RESPONSE', 'Provider response did not contain a valid API envelope.');
      const body = parsed.data;
      const retryable = response.status === 429 || response.status >= 500 || body.code === 99991400;
      if (retryable && attempt + 1 < attempts) {
        const retryAfter = Number(response.headers.get('retry-after') ?? 0);
        await sleep(Math.min(3000, Math.max(250 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)), undefined, { signal });
        continue;
      }
      if (!response.ok || body.code !== 0) {
        throw new AppError(response.status === 401 ? 'LOGIN_REQUIRED' : retryable ? 'RATE_OR_PROVIDER_ERROR' : 'FEISHU_ERROR',
          'Feishu rejected the request. Check user scopes and resource permissions; no identity fallback was attempted.',
          { code: body.code, httpStatus: response.status, ...(body.error?.log_id ? { requestId: body.error.log_id } : {}),
            ...(body.error?.permission_violations ? { requiredScopes: body.error.permission_violations.map(v => v.subject) } : {}) });
      }
      return schema.parse(body.data);
    }
    throw new AppError('RATE_OR_PROVIDER_ERROR', 'Retry budget exhausted.');
  }
}
