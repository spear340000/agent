import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { ApiRouter } from '../src/api/router.js';
import { ApiAuthenticator } from '../src/api/authentication.js';
import { createApiServer } from '../src/api/server.js';
import { LocalFileStorage } from '../src/infrastructure/storage/local-file-storage.js';
import { FileService } from '../src/application/file-service.js';
import { DocumentService } from '../src/application/document-service.js';
import { SpreadsheetService } from '../src/application/spreadsheet-service.js';
import { PdfService } from '../src/application/pdf-service.js';

test('file library, Korean downloads, new spreadsheets and PDF inspection work over HTTP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workfolio-office-api-'));
  const storage = new LocalFileStorage(root);
  const router = new ApiRouter({ files: new FileService(storage), documents: new DocumentService(storage), spreadsheets: new SpreadsheetService(storage), pdfs: new PdfService(storage), authenticator: new ApiAuthenticator() } as never);
  const server = createApiServer(router);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (endpoint: string, input: unknown) => fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  try {
    const created = await post('/api/spreadsheets/create', { outputName: '예산', operations: [{ kind: 'addSheet', name: '예산' }, { kind: 'setCell', sheet: '예산', cell: 'A1', value: 15000 }] });
    assert.equal(created.status, 201);
    const { file } = await created.json() as { file: { id: string; name: string } };
    assert.equal(file.name, '예산.xlsx');
    const inspect = await post('/api/spreadsheets/inspect', { fileId: file.id, sheet: '예산', range: 'A1' });
    assert.deepEqual((await inspect.json() as { cells: unknown[] }).cells, [{ address: 'A1', value: 15000 }]);
    const download = await fetch(`${base}/api/files/${file.id}/content`);
    assert.equal(download.status, 200);
    assert.ok(download.headers.get('content-disposition')?.includes("filename*=UTF-8''%EC%98%88%EC%82%B0.xlsx"));
    assert.ok((await download.arrayBuffer()).byteLength > 1000);
    const pdf = await PDFDocument.create(); pdf.addPage([300, 400]);
    const saved = await storage.save({ name: '페이지.pdf', mimeType: 'application/pdf', content: await pdf.save() });
    const inspected = await post('/api/pdfs/inspect', { fileId: saved.id });
    assert.equal(inspected.status, 200);
    assert.deepEqual((await inspected.json() as { pages: unknown[] }).pages, [{ number: 1, width: 300, height: 400, rotation: 0 }]);
    const library = await fetch(`${base}/api/files?limit=1`);
    assert.equal(library.status, 200);
    const first = await library.json() as { items: Array<{ id: string }>; nextCursor?: string };
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const next = await fetch(`${base}/api/files?limit=1&cursor=${first.nextCursor}`);
    const second = await next.json() as { items: Array<{ id: string }> };
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0]!.id, first.items[0]!.id);
    const invalid = await fetch(`${base}/api/files?limit=100000`);
    assert.equal(invalid.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
