import { parentPort, workerData } from 'node:worker_threads';
import { unzipSync } from 'fflate';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { readZip } from './zip.js';

try {
  const bytes = Buffer.from(workerData.bytes as Uint8Array);
  if (workerData.format === 'zip') {
    parentPort?.postMessage({ text: '', truncated: false, ...readZip(bytes, workerData.archiveEntry as string | undefined) });
  } else {
    let text: string; let truncated = false; let note: string | undefined;
    if (workerData.format === 'pdf') {
      const parser = new PDFParse({ data: bytes, isEvalSupported: false, useSystemFonts: false });
      try {
        const result = await parser.getText({ first: 50 });
        text = result.text; truncated = result.total > 50;
        note = 'Extracted PDF text from at most 50 pages; scanned images need OCR, which is not provided.';
      } finally { await parser.destroy(); }
    } else {
      let expanded = 0; let entries = 0;
      // Preflight the central directory without inflating it before passing to Mammoth.
      unzipSync(bytes, { filter: file => {
        expanded += file.originalSize;
        if (++entries > 2000 || expanded > 20_000_000) throw new Error('ZIP limit');
        return false;
      } });
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
      note = 'DOCX plain text only; embedded images and original layout are not extracted.';
    }
    parentPort?.postMessage({ text: text.slice(0, 100_000), truncated: truncated || text.length > 100_000, note });
  }
} catch {
  parentPort?.postMessage({ error: true });
}
