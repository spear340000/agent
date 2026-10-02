import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import test from 'node:test';
import { DocumentContentService } from '../src/application/document-content-service.ts';
import { AppError } from '../src/shared/app-error.ts';
import type { FileStorage, ManagedFile } from '../src/domain/managed-file.ts';

const stored = new Map<string, { metadata: ManagedFile; content: Uint8Array }>();
const files: FileStorage = {
  async save(input) {
    const id = `file_${stored.size + 1}`;
    const metadata: ManagedFile = {
      id,
      name: input.name,
      mimeType: input.mimeType,
      bytes: input.content.length,
      createdAt: new Date().toISOString(),
      path: id
    };
    stored.set(id, { metadata, content: Uint8Array.from(input.content) });
    return metadata;
  },
  async get(id) {
    return stored.get(id)?.metadata ?? null;
  },
  async read(id) {
    const entry = stored.get(id);
    if (!entry) throw new Error('file not found');
    return { metadata: entry.metadata, content: Uint8Array.from(entry.content) };
  }
};

test('task source extraction reads XLSX cell values and worksheet names', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Budget');
  sheet.addRow(['Department', 'Amount']);
  sheet.addRow(['Research', 4200]);
  const metadata = await files.save({
    name: 'budget.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: Buffer.from(await workbook.xlsx.writeBuffer())
  });

  const extracted = await new DocumentContentService(files).extract(metadata.id);

  assert.equal(extracted.format, 'xlsx');
  assert.match(extracted.text, /Budget/);
  assert.match(extracted.text, /Research/);
  assert.match(extracted.text, /4200/);
})

test('task source extraction reads visible text from PPTX slides', async () => {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('ppt/presentation.xml', '<p:presentation/>');
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld><p:sp><p:txBody><a:p><a:r><a:t>Quarterly outlook</a:t></a:r></a:p></p:txBody></p:sp></p:sld>'
  );
  const metadata = await files.save({
    name: 'outlook.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    content: zip.generate({ type: 'uint8array', compression: 'DEFLATE' })
  });

  const extracted = await new DocumentContentService(files).extract(metadata.id);

  assert.equal(extracted.format, 'pptx');
  assert.match(extracted.text, /Slide 1/);
  assert.match(extracted.text, /Quarterly outlook/);
})

test('task source extraction bounds plain-text output and reports truncation', async () => {
  const metadata = await files.save({
    name: 'large.txt',
    mimeType: 'text/plain',
    content: Buffer.from('x'.repeat(200_001))
  });

  const extracted = await new DocumentContentService(files).extract(metadata.id);

  assert.equal(extracted.text.length, 200_000);
  assert.deepEqual(extracted.warnings, ['Document text was truncated to keep extraction bounded.']);
});

test('malformed supported documents are reported as client input errors', async () => {
  const malformed = [
    ['broken.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['broken.pdf', 'application/pdf'],
    ['broken.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['broken.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
  ] as const;
  const service = new DocumentContentService(files);

  for (const [name, mimeType] of malformed) {
    const metadata = await files.save({ name, mimeType, content: Buffer.from('not a valid document') });
    await assert.rejects(
      service.extract(metadata.id),
      error => error instanceof AppError && error.statusCode === 400,
      `${name} should not surface as an internal server error`
    );
  }
});
