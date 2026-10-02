import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import type { FileStorage, ManagedFile } from '../src/domain/managed-file.ts';
import { DocumentService } from '../src/application/document-service.ts';
import { RedactionService } from '../src/application/redaction-service.ts';

const records = new Map<string, { metadata: ManagedFile; content: Uint8Array }>();
let nextId = 0;
const storage: FileStorage = {
  save: async input => {
    const id = `file_${++nextId}`;
    const metadata: ManagedFile = { id, name: input.name, mimeType: input.mimeType, bytes: input.content.length, createdAt: new Date().toISOString(), path: input.name };
    records.set(id, { metadata, content: input.content });
    return metadata;
  },
  get: async id => records.get(id)?.metadata ?? null,
  read: async id => { const item = records.get(id); if (!item) throw new Error('missing fixture'); return item; },
};

const sourceZip = new PizZip();
sourceZip.file('[Content_Types].xml', '<Types/>');
sourceZip.file('word/document.xml', '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Before sec</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>ret after; put value</w:t></w:r></w:p></w:body></w:document>');
sourceZip.file('word/header1.xml', '<w:hdr xmlns:w="urn:w"><w:p><w:r><w:t>secret header</w:t></w:r></w:p></w:hdr>');
sourceZip.file('docProps/core.xml', '<cp:coreProperties xmlns:cp="urn:cp"><dc:creator xmlns:dc="urn:dc">secret author</dc:creator></cp:coreProperties>');
const source = await storage.save({ name: 'source.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: sourceZip.generate({ type: 'nodebuffer' }) });
const service = new DocumentService(storage);

const templateSource = await service.create({ outputName: 'template.docx', title: 'Template', paragraphs: ['Dear {name}', 'Repeat {name}'] });
const malformedTemplate = await storage.save({ name: 'malformed.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('PK\u0003\u0004invalid') });
await assert.rejects(() => service.fillTemplate({ fileId: malformedTemplate.id, outputName: 'bad-filled.docx', variables: {} }), /invalid DOCX template/);
await assert.rejects(
  () => service.fillTemplate({ fileId: templateSource.id, outputName: 'missing.docx', variables: {} }),
  /missing template variables/i,
);
await assert.rejects(
  () => service.fillTemplate({ fileId: templateSource.id, outputName: 'unused.docx', variables: { name: 'Alice', unused: 'typo' } }),
  /unused template variables/i,
);
const filledTemplate = await service.fillTemplate({ fileId: templateSource.id, outputName: 'filled.docx', variables: { name: 'Alice\nSmith' } });
const filledXml = new PizZip(Buffer.from((await storage.read(filledTemplate.id)).content)).file('word/document.xml')!.asText();
assert.match(filledXml, /Alice/);
assert.match(filledXml, /Smith/);
assert.equal((await storage.read(templateSource.id)).metadata.name, 'template.docx', 'template fill leaves the original unchanged');

const replaced = await service.replaceText({
  fileId: source.id,
  outputName: 'replaced.docx',
  replacements: [
    { find: 'secret', replace: 'SAFE' },
    { find: 'author', replace: 'editor' },
    { find: 'put value', replace: 'A&B <C>' },
    { find: 'not present', replace: 'irrelevant' },
  ],
});
assert.equal(replaced.replacements, 5, 'matches spanning adjacent text runs and metadata are replaced');
assert.deepEqual(replaced.missing, ['not present']);
const outputZip = new PizZip(Buffer.from((await storage.read(replaced.file.id)).content));
const body = outputZip.file('word/document.xml')!.asText();
assert.equal([...body.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(match => match[1]).join(''), 'Before SAFE after; A&amp;B &lt;C&gt;');
assert.match(body, /<w:b\/>/);
assert.match(body, /<w:i\/>/);
assert.doesNotMatch(body, /secret/);
assert.match(body, /A&amp;B &lt;C&gt;/, 'replacement text is XML escaped exactly once');
assert.match(outputZip.file('word/header1.xml')!.asText(), /SAFE header/);
assert.match(outputZip.file('docProps/core.xml')!.asText(), /SAFE editor/);
assert.match(outputZip.file('[Content_Types].xml')!.asText(), /<Types\/>/);
assert.equal((await storage.read(source.id)).metadata.name, 'source.docx', 'the original document remains unchanged');

const tabBoundaryZip = new PizZip();
tabBoundaryZip.file('[Content_Types].xml', '<Types/>');
tabBoundaryZip.file('word/document.xml', '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>foo</w:t></w:r><w:r><w:tab/><w:t>bar</w:t><w:br/><w:t>baz</w:t></w:r></w:p></w:body></w:document>');
const tabBoundarySource = await storage.save({ name: 'tab-boundary.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: tabBoundaryZip.generate({ type: 'nodebuffer' }) });
const tabBoundaryResult = await service.replaceText({ fileId: tabBoundarySource.id, outputName: 'tab-boundary-output.docx', replacements: [{ find: 'foobar', replace: 'X' }, { find: 'barbaz', replace: 'Y' }] });
assert.equal(tabBoundaryResult.replacements, 0, 'replacement must not span an intervening Word tab or line break');
const tabBoundaryOutput = new PizZip(Buffer.from((await storage.read(tabBoundaryResult.file.id)).content)).file('word/document.xml')!.asText();
assert.match(tabBoundaryOutput, /<w:t>foo<\/w:t><\/w:r><w:r><w:tab\/><w:t>bar<\/w:t><w:br\/><w:t>baz<\/w:t>/, 'visible text and line-break structure are preserved');

const privacyDoc = await new DocumentService(storage).create({
  outputName: 'privacy-source.docx',
  title: 'Privacy check',
  paragraphs: ['Contact Alice.Smith@example.com or 010-1234-5678.'],
});
const privacyZip = new PizZip(Buffer.from((await storage.read(privacyDoc.id)).content));
const privacyXml = privacyZip.file('word/document.xml')!.asText();
privacyZip.file('word/document.xml', privacyXml.replace('Alice.Smith@example.com', 'Alice.Smith@</w:t></w:r><w:r><w:t>example.com'));
privacyZip.file('docProps/core.xml', '<cp:coreProperties xmlns:cp="urn:cp"><dc:creator xmlns:dc="urn:dc">Alice.Smith@example.com</dc:creator></cp:coreProperties>');
privacyZip.file('customXml/keep.xml', '<note>must survive redaction</note>');
const splitSource = await storage.save({ name: 'privacy-source.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: privacyZip.generate({ type: 'nodebuffer' }) });
const redacted = await new RedactionService(storage).redact({ fileId: splitSource.id, outputName: 'privacy-redacted.docx', rules: ['email', 'phone'] });
assert.equal(redacted.replacements, 3, 'redaction includes body and metadata occurrences');
const redactedZip = new PizZip(Buffer.from((await storage.read(redacted.file.id)).content));
assert.ok(redactedZip.file('customXml/keep.xml'), 'redaction preserves unrelated Office package parts');
for (const name of Object.keys(redactedZip.files).filter(name => name.endsWith('.xml'))) {
  const xml = redactedZip.file(name)?.asText() ?? '';
  assert.doesNotMatch(xml, /Alice\.Smith@example\.com|010-1234-5678/, `sensitive text remains in ${name}`);
}

console.log('DOCX round-trip tests passed');
