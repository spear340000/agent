import type { FileStorage, ManagedFile } from '../domain/managed-file.js';
import { badRequest } from '../shared/app-error.js';
import PizZip from 'pizzip';

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const MAX_ARCHIVE_ENTRIES = 2_048;

function inspectOfficeArchive(content: Uint8Array, extension: string, maxExpandedBytes: number, maxEntries: number): void {
  const buffer = Buffer.from(content);
  const searchFrom = Math.max(0, buffer.length - 22 - 65_535);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= searchFrom; offset--) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD) { endOffset = offset; break; }
  }
  if (endOffset < 0 || endOffset + 22 > buffer.length) throw badRequest('invalid Office archive');
  const disk = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0 || entryCount > maxEntries
    || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || endOffset + 22 + commentLength !== buffer.length || centralOffset + centralSize !== endOffset) {
    throw badRequest('invalid or unsupported Office archive directory');
  }

  let offset = centralOffset;
  let expandedBytes = 0;
  const names = new Set<string>();
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== ZIP_CENTRAL) throw badRequest('invalid Office archive directory');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const expandedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const startDisk = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (recordEnd > endOffset || startDisk !== 0 || (flags & 1) !== 0 || ![0, 8].includes(method)
      || compressedSize === 0xffffffff || expandedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw badRequest('unsupported or invalid Office archive entry');
    }
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
    catch { throw badRequest('invalid Office archive entry name'); }
    const pathParts = name.split('/');
    const checkedParts = name.endsWith('/') ? pathParts.slice(0, -1) : pathParts;
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0') || name.includes(':')
      || checkedParts.some(part => !part || part === '.' || part === '..')) throw badRequest('unsafe archive path');
    if (names.has(name)) throw badRequest('duplicate Office archive path');
    names.add(name);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) throw badRequest('symbolic links are not allowed in Office archives');
    if (expandedSize > maxExpandedBytes - expandedBytes) throw badRequest('expanded archive exceeds the configured limit');
    if (expandedSize > 0 && compressedSize === 0) throw badRequest('invalid Office archive compression sizes');
    expandedBytes += expandedSize;
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL) throw badRequest('invalid Office archive local entry');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localNameLength !== nameBytes.length || !localName.equals(nameBytes)
      || localOffset + 30 + localNameLength + localExtraLength + compressedSize > centralOffset) throw badRequest('invalid Office archive local entry');
    offset = recordEnd;
  }
  if (offset !== centralOffset + centralSize) throw badRequest('invalid Office archive directory size');

  try {
    const zip = new PizZip(buffer);
    const required = extension === 'docx' ? ['[Content_Types].xml', 'word/document.xml']
      : extension === 'xlsx' ? ['[Content_Types].xml', 'xl/workbook.xml']
        : ['[Content_Types].xml', 'ppt/presentation.xml'];
    if (required.some(name => !zip.file(name))) throw badRequest(`Office archive is missing required .${extension} content`);
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error) throw error;
    throw badRequest('invalid Office archive');
  }
}

export class FileService {
  constructor(private readonly files: FileStorage, private readonly limits: { maxUploadBytes?: number; maxExpandedBytes?: number; maxArchiveEntries?: number } = {}) {
    for (const [name, value] of Object.entries({ maxUploadBytes: limits.maxUploadBytes, maxExpandedBytes: limits.maxExpandedBytes, maxArchiveEntries: limits.maxArchiveEntries })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${name} must be a positive integer`);
    }
  }
  async uploadBase64(input: { name: string; mimeType: string; base64: string }): Promise<ManagedFile> {
    if (!input.name.trim() || !input.mimeType.trim() || !input.base64.trim()) throw badRequest('name, mimeType, and base64 are required');
    const maxBytes = this.limits.maxUploadBytes ?? 10 * 1024 * 1024;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) throw badRequest('base64 payload is malformed');
    if (input.base64.length > Math.ceil(maxBytes / 3) * 4) throw badRequest(`maximum upload size is ${maxBytes} bytes`);
    const content = Buffer.from(input.base64, 'base64');
    if (!content.length) throw badRequest('uploaded file is empty');
    if (content.length > maxBytes) throw badRequest(`maximum upload size is ${maxBytes} bytes`);
    this.validateFile(input.name, input.mimeType, content);
    const extension = input.name.toLowerCase().split('.').pop() ?? '';
    if (['docx', 'xlsx', 'pptx'].includes(extension)) inspectOfficeArchive(content, extension, this.limits.maxExpandedBytes ?? 50 * 1024 * 1024, this.limits.maxArchiveEntries ?? MAX_ARCHIVE_ENTRIES);
    return this.files.save({ name: input.name, mimeType: input.mimeType.toLowerCase().split(';')[0]!.trim(), content });
  }
  get(id: string): Promise<ManagedFile | null> { return this.files.get(id); }
  async list(input: { limit?: number; cursor?: string; search?: string } = {}): Promise<{ items: ManagedFile[]; nextCursor?: string }> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw badRequest('limit must be between 1 and 200');
    if ((input.search?.length ?? 0) > 200) throw badRequest('search must be at most 200 characters');
    if (!this.files.list) throw badRequest('this storage adapter does not support file listing');
    const query = input.search?.trim().toLocaleLowerCase();
    const files = (await this.files.list()).filter(file => !query || file.name.toLocaleLowerCase().includes(query));
    const index = input.cursor ? files.findIndex(file => file.id === input.cursor) : -1;
    if (input.cursor && index < 0) throw badRequest('invalid file cursor');
    const items = files.slice(index + 1, index + 1 + limit);
    return { items, ...(index + 1 + limit < files.length ? { nextCursor: items.at(-1)!.id } : {}) };
  }
  read(id: string): Promise<{ metadata: ManagedFile; content: Uint8Array }> { return this.files.read(id); }
  private validateFile(name: string, mimeType: string, content: Uint8Array): void {
    if (/[\u0000-\u001f\u007f]/.test(mimeType)) throw badRequest('invalid mimeType');
    const extension = name.toLowerCase().split('.').pop() ?? '';
    const mime = mimeType.toLowerCase().split(';')[0]?.trim();
    const expected: Record<string, string[]> = {
      pdf: ['application/pdf'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      txt: ['text/plain'], csv: ['text/csv', 'application/csv', 'text/plain'],
    };
    if (!expected[extension]) throw badRequest('unsupported file extension; supported uploads are PDF, DOCX, XLSX, PPTX, TXT, and CSV');
    if (!expected[extension]?.includes(mime ?? '')) throw badRequest(`mimeType does not match .${extension} file`);
    const signature = Buffer.from(content.subarray(0, 8));
    if (extension === 'pdf' && !signature.toString('ascii').startsWith('%PDF-')) throw badRequest('file contents are not a valid PDF');
    if (['docx', 'xlsx', 'pptx'].includes(extension) && !(signature[0] === 0x50 && signature[1] === 0x4b)) throw badRequest(`file contents are not a valid .${extension} archive`);
  }
}
