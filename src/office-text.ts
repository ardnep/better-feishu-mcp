import { inspectZip, readZip } from './zip.js';

// Deliberately text-only OOXML extraction. No relationships, URLs, macros,
// formulas, embedded objects or XML declarations are executed/resolved.
function xml(bytes: Uint8Array) {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('XML declarations are unsupported');
  return value;
}
function decode(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity in named) return named[entity]!;
    const point = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(point) || point <= 0 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new Error('Invalid XML character');
    return String.fromCodePoint(point);
  });
}
function texts(value: string) {
  return [...value.matchAll(/<(?:[\w]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w]+:)?t>/g)].map(m => decode(m[1]!)).join('');
}
function attribute(value: string, name: string) {
  const match = value.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`));
  return match ? decode(match[2]!) : undefined;
}
export function extractOfficeText(bytes: Buffer, format: 'xlsx' | 'pptx') {
  const archive = inspectZip(bytes);
  const read = (name: string) => xml(readZip(bytes, name).entryBytes!);
  const parts: string[] = []; let length = 0; let truncated = false;
  function append(text: string) { length += text.length; if (length <= 100_000) parts.push(text); else { parts.push(text.slice(0, Math.max(0, 100_000 - (length - text.length)))); truncated = true; } }
  if (format === 'xlsx') {
    const shared = archive.entries.some(e => e.name === 'xl/sharedStrings.xml')
      ? [...read('xl/sharedStrings.xml').matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(m => texts(m[1]!)) : [];
    const sheets = archive.entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    if (!sheets.length) throw new Error('No worksheets');
    for (const sheet of sheets) {
      append(`\n[Worksheet part: ${sheet.name}]\n`);
      for (const cell of read(sheet.name).matchAll(/<(?:\w+:)?c\b([^>]*?)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
        const type = attribute(cell[1]!, 't'); const address = attribute(cell[1]!, 'r') ?? '?';
        const content = cell[2]!;
        const raw = content.match(/<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
        let value = type === 'inlineStr' ? texts(content) : decode(raw ?? '');
        if (type === 's') { if (!/^\d+$/.test(value) || Number(value) >= shared.length) throw new Error('Invalid shared-string index'); value = shared[Number(value)]!; }
        const formula = content.match(/<(?:\w+:)?f(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?f>/)?.[1];
        append(`${address}\t${formula !== undefined ? `[formula: ${decode(formula)}; cached: ${value}]` : value}\n`);
        if (truncated) break;
      }
      if (truncated) break;
    }
  } else {
    const slides = archive.entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    if (!slides.length) throw new Error('No slides');
    for (const slide of slides) {
      append(`\n[Slide part: ${slide.name}]\n`);
      const value = read(slide.name);
      for (const paragraph of value.matchAll(/<(?:\w+:)?p(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?p>/g)) { append(texts(paragraph[1]!) + '\n'); if (truncated) break; }
      if (truncated) break;
    }
  }
  return { text: parts.join(''), truncated, note: format === 'xlsx'
    ? 'XLSX cell text and cached raw values only, in worksheet-part order (not workbook display order). Dates are raw serials; formulas are shown, never evaluated. Sheet names, formatting, charts, images, macros, external links and hidden-state semantics are not reconstructed.'
    : 'PPTX slide text only, in slide-part order (not presentation display order). Layout, charts, images, speaker notes, animations and embedded objects are not extracted.' };
}
