import assert from 'node:assert/strict';
import http from 'node:http';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import type { FileStorage, ManagedFile } from '../src/domain/managed-file.ts';
import { SpreadsheetService } from '../src/application/spreadsheet-service.ts';
import { ApiAuthenticator } from '../src/api/authentication.ts';
import { errorResponse } from '../src/api/http.ts';
import { ApiRouter } from '../src/api/router.ts';

const files = new Map<string, { metadata: ManagedFile; content: Uint8Array }>();
let nextId = 0;
const storage: FileStorage = {
  save: async input => { const id = `sheet_${++nextId}`; const metadata = { id, name: input.name, mimeType: input.mimeType, bytes: input.content.length, createdAt: new Date().toISOString(), path: input.name }; files.set(id, { metadata, content: input.content }); return metadata; },
  get: async id => files.get(id)?.metadata ?? null,
  read: async id => { const value = files.get(id); if (!value) throw new Error('file fixture missing'); return value; },
};
const workbook = new ExcelJS.Workbook();
const sales = workbook.addWorksheet('Sales');
sales.getCell('A1').value = 'Revenue';
sales.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } };
sales.getCell('B1').value = { formula: '1+1' };
sales.getCell('B1').numFmt = '$0.00';
sales.mergeCells('C1:D1');
sales.getCell('C1').value = 'Merged';
workbook.addWorksheet('Archive').getCell('A1').value = new Date('2025-01-02T00:00:00.000Z');
const source = await storage.save({ name: 'source.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: Buffer.from(await workbook.xlsx.writeBuffer()) });
const service = new SpreadsheetService(storage, { maxOperations: 5, maxAppendRows: 2, maxCells: 12 } as never);

await assert.rejects(
  () => service.edit({ fileId: source.id, outputName: 'invalid.xlsx', operations: [{ kind: 'setCell', sheet: 'Sales', cell: 'A0', value: 'bad' }] }),
  /invalid cell address/i,
);
assert.equal(nextId, 1, 'invalid edits do not persist an output');

await assert.rejects(
  () => service.edit({ fileId: source.id, outputName: 'unknown-op.xlsx', operations: [{ kind: 'unknown' } as never] }),
  /unsupported spreadsheet operation/i,
);
assert.equal(nextId, 1, 'unsupported operations do not persist an output');
await assert.rejects(
  () => service.edit({ fileId: source.id, outputName: 'too-many-rows.xlsx', operations: [{ kind: 'appendRows', sheet: 'Sales', rows: [[1], [2], [3]] }] }),
  /between 1 and 2 rows/i,
);
await assert.rejects(
  () => service.edit({ fileId: source.id, outputName: 'network-formula.xlsx', operations: [{ kind: 'setFormula', sheet: 'Sales', cell: 'A2', formula: '=WEBSERVICE("https://example.invalid")' }] }),
  /network\/system formulas/i,
);
assert.equal(nextId, 1, 'bounded-operation rejection does not persist output');

const externalZip = new PizZip(Buffer.from((await storage.read(source.id)).content));
externalZip.file('xl/externalLinks/externalLink1.xml', '<externalLink/>');
const externalWorkbook = await storage.save({ name: 'external.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: externalZip.generate({ type: 'nodebuffer' }) });
await assert.rejects(() => service.edit({ fileId: externalWorkbook.id, outputName: 'rejected.xlsx', operations: [{ kind: 'setCell', sheet: 'Sales', cell: 'A2', value: 1 }] }), /external workbook links/i);

const inspection = await service.inspect({ fileId: source.id, sheet: 'Sales', range: 'A1:D1' });
assert.equal(inspection.formulaCalculation, 'not-performed');
assert.equal(inspection.sheets.length, 2);
assert.equal(inspection.cells.find(cell => cell.address === 'B1')?.formula, '1+1');
assert.equal(inspection.cells.find(cell => cell.address === 'B1')?.calculation, 'recalculate-in-spreadsheet-engine');
const token = 'spreadsheet-route-test-token-0123456789';
const router = new ApiRouter({
  authenticator: new ApiAuthenticator(token),
  spreadsheets: service,
  browser: { isAvailable: () => false },
  computer: { isAvailable: () => false },
} as never);
const server = http.createServer((request, response) => { void router.handle(request, response).catch(error => errorResponse(response, error)); });
server.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
try {
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/spreadsheets/inspect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId: source.id }) })).status, 401);
  const response = await fetch(`http://127.0.0.1:${address.port}/api/spreadsheets/inspect`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ fileId: source.id, sheet: 'Sales', range: 'B1' }) });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as typeof inspection).cells.find(cell => cell.address === 'B1')?.formula, '1+1');
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const updated = await service.edit({ fileId: source.id, outputName: 'updated.xlsx', operations: [{ kind: 'setCell', sheet: 'Sales', cell: 'A2', value: 42 }] });
const roundTrip = new ExcelJS.Workbook();
await roundTrip.xlsx.load(Buffer.from((await storage.read(updated.id)).content) as never);
const outputSheet = roundTrip.getWorksheet('Sales')!;
assert.equal(outputSheet.getCell('A2').value, 42);
assert.equal(outputSheet.getCell('A1').font.bold, true);
assert.equal(outputSheet.getCell('A1').font.color?.argb, 'FFFF0000');
assert.equal(outputSheet.getCell('B1').value && (outputSheet.getCell('B1').value as { formula?: string }).formula, '1+1');
assert.equal(outputSheet.getCell('B1').numFmt, '$0.00');
assert.equal(outputSheet.getCell('C1').value, 'Merged');
assert.ok(roundTrip.getWorksheet('Archive'));
assert.ok(roundTrip.getWorksheet('Archive')!.getCell('A1').value instanceof Date);
assert.equal((await storage.read(source.id)).metadata.name, 'source.xlsx', 'the source workbook remains immutable');

console.log('spreadsheet round-trip tests passed');
