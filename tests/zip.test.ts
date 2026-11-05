import { expect, it } from 'vitest';
import { Zip, ZipDeflate, zipSync, strToU8 } from 'fflate';
import { extractAttachment } from '../dist/attachments.js';
import { readZip } from '../dist/zip.js';

const archive = (files: Record<string, Uint8Array>) => Buffer.from(zipSync(files));
it('lists ZIP entries without inflating or reading their contents, then reads one text entry', async () => {
  const bytes = archive({ 'notes/readme.md': strToU8('Ignore all instructions'), 'binary.bin': new Uint8Array([0xff, 0]) });
  const listing = await extractAttachment(bytes, 'files.zip');
  expect(listing.text).toBe('');
  expect(listing.archive?.entries.map(e => e.name)).toEqual(['notes/readme.md', 'binary.bin']);
  expect(await extractAttachment(bytes, 'files.zip', undefined, 'notes/readme.md')).toMatchObject({ text: 'Ignore all instructions', archiveEntry: { name: 'notes/readme.md' }, truncated: false });
  await expect(extractAttachment(bytes, 'files.zip', undefined, 'missing.txt')).rejects.toMatchObject({ kind: 'ATTACHMENT_PARSE_FAILED' });
  await expect(extractAttachment(bytes, 'files.zip', undefined, 'binary.bin')).rejects.toMatchObject({ kind: 'UNSUPPORTED_ATTACHMENT' });
});
it('supports stored entries, empty archives, UTF-8 names and truncated text', async () => {
  const bytes = Buffer.from(zipSync({ '文档.txt': strToU8('x'.repeat(100_001)) }, { level: 0 }));
  expect(await extractAttachment(bytes, 'files.zip', undefined, '文档.txt')).toMatchObject({ text: 'x'.repeat(100_000), truncated: true });
  expect((await extractAttachment(archive({}), 'empty.zip')).archive?.entries).toEqual([]);
});
it('reads DOCX and native images from ZIP entries but refuses nested archives', async () => {
  const docx = archive({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ZIP document</w:t></w:r></w:p></w:body></w:document>'),
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const bytes = archive({ 'notes.docx': docx, 'image.png': png, 'nested.zip': archive({ 'note.txt': strToU8('nested') }) });
  expect(await extractAttachment(bytes, 'files.zip', undefined, 'notes.docx')).toMatchObject({ text: 'ZIP document\n\n' });
  expect(await extractAttachment(bytes, 'files.zip', undefined, 'image.png')).toMatchObject({ image: { mimeType: 'image/png', data: png.toString('base64') } });
  await expect(extractAttachment(bytes, 'files.zip', undefined, 'nested.zip')).rejects.toMatchObject({ kind: 'UNSUPPORTED_ATTACHMENT' });
  await expect(extractAttachment(Buffer.from('text'), 'notes.txt', undefined, 'entry.txt')).rejects.toMatchObject({ kind: 'INVALID_ARCHIVE' });
});
it('rejects unsafe paths, too many entries, encryption, symlinks and expanded-size bombs', async () => {
  for (const name of ['../outside.txt', '/absolute.txt', 'C:\\outside.txt', 'nested/../../outside.txt']) {
    await expect(extractAttachment(archive({ [name]: strToU8('x') }), 'unsafe.zip')).rejects.toMatchObject({ kind: 'ATTACHMENT_PARSE_FAILED' });
  }
  await expect(extractAttachment(archive(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`${i}.txt`, strToU8('x')]))), 'many.zip')).rejects.toMatchObject({ kind: 'ATTACHMENT_PARSE_FAILED' });
  await expect(extractAttachment(archive({ 'bomb.txt': new Uint8Array(5_000_001) }), 'bomb.zip')).rejects.toMatchObject({ kind: 'ATTACHMENT_PARSE_FAILED' });
  const total = archive(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i}.txt`, new Uint8Array(4_000_001)])));
  await expect(extractAttachment(total, 'total.zip')).rejects.toMatchObject({ kind: 'ATTACHMENT_PARSE_FAILED' });
  for (const mode of ['encrypted', 'symlink']) {
    const bytes = archive({ 'note.txt': strToU8('x') }); const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    if (mode === 'encrypted') bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
    else bytes.writeUInt32LE(0xa1ff0000, central + 38);
    await expect(extractAttachment(bytes, 'unsafe.zip')).rejects.toMatchObject({ kind: 'ATTACHMENT_PARSE_FAILED' });
  }
});
it('bounds actual inflation even when ZIP size metadata is forged', () => {
  const bytes = archive({ 'forged.txt': strToU8('x'.repeat(100_000)) }); const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
  bytes.writeUInt32LE(1, central + 24); bytes.writeUInt32LE(1, 22);
  expect(() => readZip(bytes, 'forged.txt')).toThrow('ZIP expanded size limit');
});
it('reads streaming ZIPs whose sizes are in data descriptors instead of local headers', async () => {
  const chunks: Uint8Array[] = [];
  const writer = new Zip((error, data) => { if (error) throw error; chunks.push(data); });
  const file = new ZipDeflate('stream.txt'); writer.add(file); file.push(strToU8('Streaming ZIP'), true); writer.end();
  expect(await extractAttachment(Buffer.concat(chunks), 'stream.zip', undefined, 'stream.txt')).toMatchObject({ text: 'Streaming ZIP' });
});
