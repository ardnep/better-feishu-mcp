import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './core.js';
import type { FeishuHttp } from './http.js';
import type { ScopeGroups } from './productivity.js';
export const localPath = z.string().min(1).max(4096).refine(p => isAbsolute(p) && normalize(p) === p && !p.includes('\0'), 'Use a canonical absolute local path.');
const maximum = 5_000_000;
export async function uploadForm(input: { path: string; fields: Record<string, string>; sizeField?: boolean }, signal?: AbortSignal) {
  localPath.parse(input.path); signal?.throwIfAborted();
  if (await realpath(input.path) !== input.path) throw new AppError('UNSAFE_FILE', 'Symlink components are not allowed.');
  const file = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new AppError('UNSAFE_FILE', 'Upload must be a regular file of at most 5000000 bytes.');
    const buffer = Buffer.alloc(maximum + 1); let size = 0;
    while (size < buffer.length) { signal?.throwIfAborted(); const r = await file.read(buffer, size, buffer.length - size, null); if (!r.bytesRead) break; size += r.bytesRead; }
    if (size > maximum) throw new AppError('FILE_TOO_LARGE', 'Upload exceeds 5000000 bytes.');
    const form = new FormData();
    for (const [key, value] of Object.entries(input.fields)) form.set(key, value);
    if (input.sizeField) { form.set('size', String(size)); form.set('file_name', basename(input.path)); }
    form.set('file', new Blob([new Uint8Array(buffer.subarray(0, size))]), basename(input.path));
    return form;
  } finally { await file.close(); }
}
export async function downloadFile(api: FeishuHttp, path: string, destination: string, scopes: ScopeGroups, signal?: AbortSignal) {
  localPath.parse(destination); signal?.throwIfAborted();
  if (await realpath(dirname(destination)) !== dirname(destination)) throw new AppError('UNSAFE_FILE', 'Destination parent must be canonical without symlinks.');
  // Reserve exclusively before the read; never truncate or follow an existing target.
  const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = await api.download(path, { scopes, signal }); signal?.throwIfAborted();
    await file.writeFile(bytes); await file.sync();
    return { path: destination, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), untrustedData: true };
  } catch (error) {
    // Retain an empty/partial exclusive target on failure; never unlink a path another process may have replaced.
    throw new AppError('DOWNLOAD_FAILED', 'Download failed; the exclusively created destination may be empty or partial. Inspect it before choosing a new path.', { destination, cause: error instanceof AppError ? error.kind : 'LOCAL_OR_NETWORK_ERROR' });
  } finally { await file.close(); }
}
