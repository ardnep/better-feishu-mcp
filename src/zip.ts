import { Unzip, UnzipInflate } from 'fflate';

export type ZipEntry = { name: string; sizeBytes: number; compressedBytes: number; directory: boolean };
export type ZipContents = { entries: ZipEntry[]; totalExpandedBytes: number };
const MAX_ENTRY_BYTES = 5_000_000;
const MAX_TOTAL_BYTES = 20_000_000;
function safeName(name: string) {
  return name.length > 0 && name.length <= 512 && Buffer.byteLength(name) <= 1024 && !/[\x00-\x1f\x7f\\:]/.test(name)
    && !name.startsWith('/') && !name.split('/').some(part => part === '..' || part === '.');
}
function checkExtra(bytes: Buffer, offset: number, length: number) {
  const end = offset + length;
  if (end > bytes.length) throw new Error('Invalid ZIP extra fields');
  while (offset < end) {
    if (offset + 4 > end) throw new Error('Invalid ZIP extra field');
    const tag = bytes.readUInt16LE(offset); const size = bytes.readUInt16LE(offset + 2);
    if (tag === 1 || offset + 4 + size > end) throw new Error('ZIP64 or invalid ZIP extra field');
    offset += 4 + size;
  }
}
// Read central-directory metadata without inflating entries. ZIP64, spanning,
// encryption and symlinks are deliberately unsupported. Nothing is written to disk.
export function inspectZip(bytes: Buffer): ZipContents {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error('Invalid ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12); const directoryOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count
      || count > 200 || directoryOffset + directorySize !== end) throw new Error('Unsupported or excessive ZIP directory');
  const entries: ZipEntry[] = []; const names = new Set<string>();
  let offset = directoryOffset; let totalExpandedBytes = 0; let nameBytes = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(offset + 8); const method = bytes.readUInt16LE(offset + 10);
    const compressedBytes = bytes.readUInt32LE(offset + 20); const sizeBytes = bytes.readUInt32LE(offset + 24);
    const length = bytes.readUInt16LE(offset + 28); const extra = bytes.readUInt16LE(offset + 30); const comment = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + length + extra + comment; const localOffset = bytes.readUInt32LE(offset + 42);
    if (next > end || flags & (1 | 64) || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34)
        || (bytes.readUInt32LE(offset + 38) >>> 16 & 0xf000) === 0xa000) throw new Error('Unsupported ZIP entry');
    checkExtra(bytes, offset + 46 + length, extra);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + length));
    if (!safeName(name) || names.has(name)) throw new Error('Unsafe or duplicate ZIP path');
    names.add(name); nameBytes += length; totalExpandedBytes += sizeBytes;
    if (sizeBytes > MAX_ENTRY_BYTES || totalExpandedBytes > MAX_TOTAL_BYTES || nameBytes > 100_000) throw new Error('ZIP size limit');
    if (localOffset + 30 > directoryOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP local header');
    const localFlags = bytes.readUInt16LE(localOffset + 6); const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26); const localExtra = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtra;
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localFlags !== flags || localMethod !== method || dataOffset + compressedBytes > directoryOffset
        || !localName.equals(bytes.subarray(offset + 46, offset + 46 + length))) throw new Error('Inconsistent ZIP headers');
    checkExtra(bytes, localOffset + 30 + localNameLength, localExtra);
    entries.push({ name, sizeBytes, compressedBytes, directory: name.endsWith('/') }); offset = next;
  }
  if (offset !== end) throw new Error('Invalid ZIP directory size');
  return { entries, totalExpandedBytes };
}
export function readZip(bytes: Buffer, entryName?: string) {
  const archive = inspectZip(bytes);
  if (entryName === undefined) return { archive };
  const entry = archive.entries.find(item => item.name === entryName && !item.directory);
  if (!entry) throw new Error('ZIP entry not found');
  const chunks: Uint8Array[] = []; let size = 0; let completed = false; let matches = 0;
  const stream = new Unzip(file => {
    if (file.name !== entryName) return;
    if (++matches > 1) throw new Error('Duplicate ZIP local entry');
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length;
      // Enforce the actual inflated size too, not just attacker-controlled metadata.
      if (size > MAX_ENTRY_BYTES || size > entry.sizeBytes) throw new Error('ZIP expanded size limit');
      chunks.push(chunk); completed = final;
    };
    file.start();
  });
  stream.register(UnzipInflate);
  // Small compressed chunks bound each inflation step, even for forged sizes.
  for (let offset = 0; offset < bytes.length; offset += 512) stream.push(bytes.subarray(offset, offset + 512), offset + 512 >= bytes.length);
  if (matches !== 1 || !completed || size !== entry.sizeBytes) throw new Error('Incomplete ZIP entry');
  return { archive, entryBytes: new Uint8Array(Buffer.concat(chunks)), entry };
}
