import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import type { FileStorage, ManagedFile } from '../src/domain/managed-file.ts';
import { PdfService } from '../src/application/pdf-service.ts';

const files = new Map<string, { metadata: ManagedFile; content: Uint8Array }>();
let nextId = 0;
const storage: FileStorage = {
  save: async input => { const id = `pdf_${++nextId}`; const metadata = { id, name: input.name, mimeType: input.mimeType, bytes: input.content.length, createdAt: new Date().toISOString(), path: input.name }; files.set(id, { metadata, content: input.content }); return metadata; },
  get: async id => files.get(id)?.metadata ?? null,
  read: async id => { const value = files.get(id); if (!value) throw new Error('file fixture missing'); return value; },
};
const document = await PDFDocument.create();
document.addPage([100, 200]);
document.addPage([200, 100]);
const source = await storage.save({ name: 'source.pdf', mimeType: 'application/pdf', content: await document.save() });
const service = new PdfService(storage);

await assert.rejects(() => service.split({ fileId: source.id, pageNumbers: [1, 3], outputPrefix: 'page' }), /invalid page/i);
assert.equal(nextId, 1, 'invalid split selections must fail before persisting any page');

const reordered = await service.edit({ fileId: source.id, outputName: 'reordered.pdf', operation: { kind: 'reorder', pageNumbers: [2, 1] } });
const reorderedPdf = await PDFDocument.load(Buffer.from((await storage.read(reordered.id)).content));
assert.deepEqual(reorderedPdf.getPages().map(page => page.getSize()), [{ width: 200, height: 100 }, { width: 100, height: 200 }]);
const rotated = await service.edit({ fileId: source.id, outputName: 'rotated.pdf', operation: { kind: 'rotatePages', pageNumbers: [1], degrees: 90 } });
assert.equal((await PDFDocument.load(Buffer.from((await storage.read(rotated.id)).content))).getPage(0)!.getRotation().angle, 90);

const malformed = await storage.save({ name: 'broken.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF- malformed data') });
await assert.rejects(() => service.merge({ fileIds: [source.id, malformed.id], outputName: 'bad-merge.pdf' }), /invalid or encrypted PDF/i);
const encryptedSentinel = await PDFDocument.create();
encryptedSentinel.addPage();
(encryptedSentinel.context.trailerInfo as Record<string, unknown>).Encrypt = encryptedSentinel.context.obj({ Filter: 'Standard' });
const encrypted = await storage.save({ name: 'encrypted-sentinel.pdf', mimeType: 'application/pdf', content: await encryptedSentinel.save() });
await assert.rejects(() => service.merge({ fileIds: [source.id, encrypted.id], outputName: 'encrypted-merge.pdf' }), /invalid or encrypted PDF/i);
assert.equal((await PDFDocument.load(Buffer.from((await storage.read(source.id)).content))).getPageCount(), 2, 'the source PDF remains unchanged');

console.log('PDF round-trip tests passed');
