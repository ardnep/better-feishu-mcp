import { z } from 'zod';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, normalize } from 'node:path';
import { AppError } from './core.js';
import type { Content } from './services.js';

export const MEDIA_UPLOAD_SCOPE = 'docs:document.media:upload';
export const MEDIA_UPLOAD_SCOPES = [[MEDIA_UPLOAD_SCOPE, 'docs:doc', 'drive:drive', 'bitable:app', 'sheets:spreadsheet']] as const;
export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_IMAGE_TOTAL_BYTES = 20_000_000;
export const imageBlockSchema = z.object({
  type: z.literal('image'),
  path: z.string().min(1).max(4096).refine(p => isAbsolute(p) && !p.includes('\0'), 'Provide an absolute local image path, not a URL.'),
  caption: z.string().max(1000).optional(),
}).strict();
export const imageManifestSchema = z.array(z.object({
  path: z.string().min(1).max(4096), fileName: z.string().min(1).max(250),
  mimeType: z.enum(['image/png', 'image/jpeg']), sizeBytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive().max(20_000), height: z.number().int().positive().max(20_000),
}).strict()).max(10);
export type ImageManifest = z.infer<typeof imageManifestSchema>;
export type LoadedImages = Map<string, { metadata: ImageManifest[number]; bytes: Buffer }>;

function dimensions(bytes: Buffer): { mimeType: 'image/png' | 'image/jpeg'; width: number; height: number } {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { mimeType: 'image/jpeg', height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
  }
  throw new AppError('UNSUPPORTED_IMAGE', 'Only PNG and JPEG images with valid dimension headers are supported; no SVG, URLs or active formats.');
}

async function readImage(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    if (!isAbsolute(path) || normalize(path) !== path || await realpath(path) !== path) {
      throw new AppError('UNSAFE_IMAGE', 'Image must be a canonical absolute path without symlink components.');
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new AppError('UNSAFE_IMAGE', 'Only regular local image files are supported.');
      if (stat.size > MAX_IMAGE_BYTES) throw new AppError('IMAGE_TOO_LARGE', 'Each image is limited to 5000000 bytes.');
      const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_IMAGE_BYTES) throw new AppError('IMAGE_TOO_LARGE', 'Each image is limited to 5000000 bytes.');
      const bytes = buffer.subarray(0, size);
      const info = dimensions(bytes);
      if (!info.width || !info.height || info.width > 20_000 || info.height > 20_000 || info.width * info.height > 40_000_000) {
        throw new AppError('UNSUPPORTED_IMAGE', 'Image dimensions exceed the 20000-per-side / 40-million-pixel limit.');
      }
      const name = basename(path).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200) || 'image';
      const extension = info.mimeType === 'image/png' ? '.png' : '.jpg';
      const fileName = name.replace(/\.[^.]*$/, '') + extension;
      return { bytes, metadata: { path, fileName, ...info, sizeBytes: size, sha256: createHash('sha256').update(bytes).digest('hex') } };
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof AppError || signal?.aborted) throw error;
    throw new AppError('UNSAFE_IMAGE', 'Image could not be read as a regular local file. Check its path and permissions.');
  }
}

export function hasImages(content?: Content) { return content?.some(b => b.type === 'image') ?? false; }

// Preparation hashes exact bytes; commit rereads them all before any network mutation.
// Buffers stay in memory only. Drafts contain bounded metadata, never image base64.
export async function loadImages(content?: Content, expected?: ImageManifest, signal?: AbortSignal) {
  const manifest: ImageManifest = []; const assets: LoadedImages = new Map(); let total = 0;
  for (const block of content ?? []) {
    if (block.type !== 'image') continue;
    if (manifest.length >= 10) throw new AppError('IMAGE_LIMIT', 'At most ten images are allowed per operation.');
    let image = assets.get(block.path);
    if (!image) { image = await readImage(block.path, signal); assets.set(block.path, image); }
    total += image.bytes.length;
    if (total > MAX_IMAGE_TOTAL_BYTES) throw new AppError('IMAGE_TOO_LARGE', 'An operation is limited to 20000000 total image bytes.');
    manifest.push(image.metadata);
  }
  const canonical = imageManifestSchema.parse(manifest);
  if (expected && JSON.stringify(canonical) !== JSON.stringify(expected)) {
    throw new AppError('IMAGE_CHANGED', 'An image differs from its approved SHA-256/metadata. Prepare and approve a new operation; no upload was attempted.');
  }
  return { manifest: canonical, assets };
}
