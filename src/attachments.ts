import { Worker } from 'node:worker_threads';
import { AppError } from './core.js';

export type Attachment = { resourceKey: string; type: 'image' | 'file'; fileName?: string };
export function attachments(item: Record<string, unknown>): Attachment[] {
  if (item.msg_type === 'sticker' || item.msg_type === 'folder') return [];
  const body = item.body as { content?: unknown } | undefined;
  let content = body?.content ?? item.content;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { return []; }
  }
  const found = new Map<string, Attachment>(); let visited = 0;
  function walk(value: unknown, depth = 0) {
    if (++visited > 10_000 || depth > 20 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
    const node = value as Record<string, unknown>;
    for (const [field, type] of [['image_key', 'image'], ['file_key', 'file']] as const) {
      const key = node[field];
      if (typeof key === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(key)) {
        found.set(type + ':' + key, { resourceKey: key, type,
          ...(typeof node.file_name === 'string' ? { fileName: node.file_name.slice(0, 1000) } : {}) });
      }
    }
    for (const child of Object.values(node)) walk(child, depth + 1);
  }
  walk(content); return [...found.values()];
}
export function enrichMessage(item: Record<string, unknown>) {
  return { ...item, attachments: attachments(item) };
}
export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return undefined;
}
export type ExtractedText = { text: string; truncated: boolean; note?: string };
export async function extractAttachment(bytes: Buffer, fileName = '', signal?: AbortSignal): Promise<ExtractedText> {
  signal?.throwIfAborted();
  const pdf = bytes.subarray(0, 5).toString() === '%PDF-';
  const docx = /\.docx$/i.test(fileName) && bytes.subarray(0, 2).toString() === 'PK';
  if (!pdf && !docx) {
    // No HTML execution, CSV formula evaluation, MIME-based trust, or binary-to-text guessing.
    if (!/\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|log|ya?ml|toml|ini|sql|[cm]?[jt]sx?|py|rs|go|java|c|h|cpp|sh)$/i.test(fileName)) {
      throw new AppError('UNSUPPORTED_ATTACHMENT', 'Readable formats: UTF-8 text/code, PNG/JPEG/GIF/WebP images, PDF and DOCX. Other formats and OCR/transcription are not supported.');
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new AppError('UNSUPPORTED_ENCODING', 'Text attachment is not valid UTF-8.'); }
    if (text.includes('\0')) throw new AppError('UNSUPPORTED_ENCODING', 'Attachment contains binary data, not readable UTF-8 text.');
    return { text: text.slice(0, 100_000), truncated: text.length > 100_000 };
  }
  // Keep untrusted document parsers off the MCP thread, bounded in time and JS heap.
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./attachment-worker.js', import.meta.url), {
      workerData: { bytes: new Uint8Array(bytes), format: pdf ? 'pdf' : 'docx' },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 }, stdout: true, stderr: true,
    });
    // Parser diagnostics must never leak attachment content to protocol stdout or logs.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (error?: AppError, value?: ExtractedText) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); void worker.terminate();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new AppError('CANCELLED', 'Attachment parsing was cancelled.'));
    const timer = setTimeout(() => finish(new AppError('ATTACHMENT_PARSE_LIMIT', 'Attachment parsing exceeded the time limit.')), 15_000);
    worker.once('message', value => {
      if (value.error) finish(new AppError('ATTACHMENT_PARSE_FAILED', 'Cannot extract this document. It may be malformed, encrypted or exceed parsing limits.'));
      else finish(undefined, value as ExtractedText);
    });
    worker.once('error', () => finish(new AppError('ATTACHMENT_PARSE_FAILED', 'Attachment parser failed or exceeded its memory limit.')));
    worker.once('exit', code => { if (code !== 0) finish(new AppError('ATTACHMENT_PARSE_FAILED', 'Attachment parser exited before completing.')); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
