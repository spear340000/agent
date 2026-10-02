import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalFileStorage } from '../src/infrastructure/storage/local-file-storage.js';

test('managed files retain Korean display names without accepting a path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workfolio-library-'));
  try {
    const storage = new LocalFileStorage(root);
    const file = await storage.save({ name: '../보고서 2026.txt', mimeType: 'text/plain', content: Buffer.from('실제 문서') });
    assert.equal(file.name, '보고서 2026.txt');
    assert.equal(Buffer.from((await storage.read(file.id)).content).toString(), '실제 문서');
    assert.equal(path.dirname(file.path), '.');
    const longName = await storage.save({ name: `${'문'.repeat(200)}.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('PK') });
    assert.ok(longName.name.endsWith('.docx'), 'truncation must preserve a supported extension');
  } finally { await rm(root, { recursive: true, force: true }); }
});
