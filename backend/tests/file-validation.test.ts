import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import type { FileStorage, ManagedFile } from '../src/domain/managed-file.ts';
import { FileService } from '../src/application/file-service.ts';

let saves = 0;
const storage: FileStorage = {
  save: async input => { saves++; return { id: `file_${saves}`, name: input.name, mimeType: input.mimeType, bytes: input.content.length, createdAt: new Date().toISOString(), path: input.name }; },
  get: async (): Promise<ManagedFile | null> => null,
  read: async () => { throw new Error('not used'); },
};
const file = (name: string, content: Buffer) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', base64: content.toString('base64') });
const docx = (text: string, entryName = 'word/document.xml') => {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file(entryName, text);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
};

const normalFile = new FileService(storage, { maxExpandedBytes: 2_048 });
await normalFile.uploadBase64(file('small.docx', docx('<document>ok</document>')));
assert.equal(saves, 1);

await assert.rejects(
  () => normalFile.uploadBase64(file('traversal.docx', docx('untrusted', '../outside.txt'))),
  /unsafe archive path/,
);
assert.equal(saves, 1, 'rejected Office archives must not be persisted');

await assert.rejects(
  () => normalFile.uploadBase64(file('oversized-expanded.docx', docx('x'.repeat(4_000)))),
  /expanded archive exceeds/,
);
assert.equal(saves, 1, 'expanded-size rejection must happen before persistence');

await assert.rejects(
  () => normalFile.uploadBase64(file('corrupt.docx', Buffer.from('PK\u0003\u0004not a zip archive'))),
  /invalid Office archive/,
);
assert.equal(saves, 1, 'corrupt Office archives must not be persisted');

await assert.rejects(
  () => normalFile.uploadBase64({ name: 'unsupported.html', mimeType: 'text/html', base64: Buffer.from('<p>not an Office source</p>').toString('base64') }),
  /unsupported file extension/,
);
await assert.rejects(
  () => normalFile.uploadBase64({ name: 'headers.txt', mimeType: 'text/plain\r\nx-injected: value', base64: Buffer.from('text').toString('base64') }),
  /invalid mimeType/,
);
assert.equal(saves, 1, 'unsupported inputs must not be persisted');

console.log('file validation tests passed');
