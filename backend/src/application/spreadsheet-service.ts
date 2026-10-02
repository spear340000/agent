import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import type { FileStorage, ManagedFile } from '../domain/managed-file.js';
import { badRequest, notFound } from '../shared/app-error.js';

export type SpreadsheetScalar = string | number | boolean | null;
export type SpreadsheetOperation =
  | { kind: 'setCell'; sheet: string; cell: string; value: SpreadsheetScalar }
  | { kind: 'setFormula'; sheet: string; cell: string; formula: string }
  | { kind: 'appendRows'; sheet: string; rows: Array<Array<SpreadsheetScalar>> }
  | { kind: 'addSheet'; name: string };
export type SpreadsheetInspection = {
  fileId: string;
  sheets: Array<{ name: string; rows: number; columns: number }>;
  selectedSheet?: string;
  range?: string;
  cells: Array<{ address: string; value: SpreadsheetScalar; formula?: string; cachedResult?: SpreadsheetScalar; calculation?: 'recalculate-in-spreadsheet-engine' }>;
  formulaCalculation: 'not-performed';
};
type CellCoordinate = { row: number; column: number };
type Limits = { maxOperations?: number; maxAppendRows?: number; maxCells?: number; maxCellCharacters?: number };

function parseCellAddress(value: string): CellCoordinate {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(value);
  if (!match) throw badRequest(`invalid cell address: ${value}`);
  let column = 0;
  for (const character of match[1]!.toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16_384 || row > 1_048_576) throw badRequest(`cell address is outside Excel limits: ${value}`);
  return { row, column };
}

function parseRange(value: string): { start: CellCoordinate; end: CellCoordinate; normalized: string } {
  const parts = value.split(':');
  if (parts.length < 1 || parts.length > 2) throw badRequest('range must be a cell or two-cell range');
  const start = parseCellAddress(parts[0]!);
  const end = parseCellAddress(parts[1] ?? parts[0]!);
  if (end.row < start.row || end.column < start.column) throw badRequest('range end must not precede its start');
  const area = (end.row - start.row + 1) * (end.column - start.column + 1);
  if (!Number.isSafeInteger(area) || area > 5_000) throw badRequest('inspection range may contain at most 5000 cells');
  return { start, end, normalized: parts.length === 1 ? parts[0]!.toUpperCase() : `${parts[0]!.toUpperCase()}:${parts[1]!.toUpperCase()}` };
}

function validSheetName(name: unknown): name is string {
  return typeof name === 'string' && !!name.trim() && name.length <= 31 && !/[\\/?*:[\]]/.test(name) && !/^'|'$/.test(name);
}

function scalar(value: unknown, maxCharacters: number): value is SpreadsheetScalar {
  return value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
    || typeof value === 'string' && value.length <= maxCharacters;
}

function plainValue(value: unknown): SpreadsheetScalar {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) return record.richText.map(part => typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '').join('');
    if (typeof record.text === 'string') return record.text;
    if (typeof record.error === 'string') return record.error;
  }
  return String(value);
}

export class SpreadsheetService {
  private readonly limits: Required<Limits>;
  constructor(private readonly files: FileStorage, limits: Limits = {}) {
    this.limits = { maxOperations: limits.maxOperations ?? 500, maxAppendRows: limits.maxAppendRows ?? 10_000, maxCells: limits.maxCells ?? 100_000, maxCellCharacters: limits.maxCellCharacters ?? 32_767 };
    for (const [name, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }

  async edit(input: { fileId: string; outputName: string; operations: SpreadsheetOperation[] }): Promise<ManagedFile> {
    const operations = this.validateOperations(input.operations);
    const source = await this.files.read(input.fileId);
    if (!source.metadata.name.toLowerCase().endsWith('.xlsx')) throw badRequest('only .xlsx files are supported');
    this.assertSupportedPackage(source.content);
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(Buffer.from(source.content) as never); }
    catch { throw badRequest('invalid or unsupported .xlsx workbook'); }
    for (const operation of operations) this.apply(workbook, operation);
    const output = Buffer.from(await workbook.xlsx.writeBuffer());
    const name = input.outputName.trim();
    if (!name) throw badRequest('outputName is required');
    return this.files.save({ name: name.toLowerCase().endsWith('.xlsx') ? name : `${name}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: output });
  }

  async create(input: { outputName: string; operations: SpreadsheetOperation[] }): Promise<ManagedFile> {
    const operations = this.validateOperations(input.operations);
    const name = input.outputName.trim();
    if (!name) throw badRequest('outputName is required');
    const workbook = new ExcelJS.Workbook();
    for (const operation of operations) this.apply(workbook, operation);
    if (!workbook.worksheets.length) throw badRequest('a spreadsheet must contain at least one worksheet');
    workbook.calcProperties.fullCalcOnLoad = true;
    return this.files.save({ name: name.toLowerCase().endsWith('.xlsx') ? name : `${name}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: Buffer.from(await workbook.xlsx.writeBuffer()) });
  }

  async inspect(input: { fileId: string; sheet?: string; range?: string }): Promise<SpreadsheetInspection> {
    const source = await this.files.read(input.fileId);
    if (!source.metadata.name.toLowerCase().endsWith('.xlsx')) throw badRequest('only .xlsx workbooks are supported');
    this.assertSupportedPackage(source.content);
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(Buffer.from(source.content) as never); }
    catch { throw badRequest('invalid or unsupported .xlsx workbook'); }
    const sheets = workbook.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount }));
    const result: SpreadsheetInspection = { fileId: input.fileId, sheets, cells: [], formulaCalculation: 'not-performed' };
    if (input.sheet === undefined) {
      if (input.range !== undefined) throw badRequest('sheet is required when inspecting a cell range');
      return result;
    }
    const sheet = workbook.getWorksheet(input.sheet);
    if (!sheet) throw notFound(`worksheet not found: ${input.sheet}`);
    const range = parseRange(input.range ?? 'A1:Z50');
    result.selectedSheet = sheet.name;
    result.range = range.normalized;
    for (let row = range.start.row; row <= range.end.row; row++) {
      for (let column = range.start.column; column <= range.end.column; column++) {
        const cell = sheet.getCell(row, column);
        const value = cell.value as unknown;
        if (value === null || value === undefined) continue;
        if (typeof value === 'object' && value && ('formula' in value || 'sharedFormula' in value)) {
          const formulaValue = value as { formula?: unknown; sharedFormula?: unknown; result?: unknown };
          result.cells.push({
            address: cell.address,
            value: plainValue(formulaValue.result),
            formula: typeof formulaValue.formula === 'string' ? formulaValue.formula : typeof formulaValue.sharedFormula === 'string' ? `shared:${formulaValue.sharedFormula}` : undefined,
            ...(formulaValue.result === undefined ? {} : { cachedResult: plainValue(formulaValue.result) }),
            calculation: 'recalculate-in-spreadsheet-engine',
          });
        } else result.cells.push({ address: cell.address, value: plainValue(value) });
      }
    }
    return result;
  }

  private validateOperations(value: unknown): SpreadsheetOperation[] {
    if (!Array.isArray(value) || !value.length || value.length > this.limits.maxOperations) throw badRequest(`operations must contain between 1 and ${this.limits.maxOperations} items`);
    let affectedCells = 0;
    const sheetNames = new Set<string>();
    return value.map((raw: unknown): SpreadsheetOperation => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('invalid spreadsheet operation');
      const operation = raw as Record<string, unknown>;
      if (!['addSheet', 'setCell', 'setFormula', 'appendRows'].includes(String(operation.kind))) throw badRequest('unsupported spreadsheet operation');
      if (operation.kind === 'addSheet') {
        if (!validSheetName(operation.name)) throw badRequest('invalid worksheet name');
        const key = operation.name.toLocaleLowerCase('en-US');
        if (sheetNames.has(key)) throw badRequest(`duplicate worksheet name: ${operation.name}`);
        sheetNames.add(key);
        return { kind: 'addSheet', name: operation.name };
      }
      if (!validSheetName(operation.sheet)) throw badRequest('invalid worksheet name');
      if (operation.kind === 'setCell') {
        if (typeof operation.cell !== 'string') throw badRequest('cell must be a string');
        parseCellAddress(operation.cell);
        if (!scalar(operation.value, this.limits.maxCellCharacters)) throw badRequest('cell value must be a string, finite number, boolean, or null within the configured size limit');
        affectedCells++;
        return { kind: 'setCell', sheet: operation.sheet, cell: operation.cell, value: operation.value };
      }
      if (operation.kind === 'setFormula') {
        if (typeof operation.cell !== 'string') throw badRequest('cell must be a string');
        parseCellAddress(operation.cell);
        if (typeof operation.formula !== 'string' || !operation.formula.trim() || operation.formula.length > 8_192) throw badRequest('formula must be a non-empty string of at most 8192 characters');
        if (/\[[^\]]+\.(?:xlsx?|xlsm)\]/i.test(operation.formula) || /\b(?:WEBSERVICE|FILTERXML|RTD|CALL|REGISTER\.ID)\s*\(/i.test(operation.formula)) throw badRequest('external workbook links and network/system formulas are not supported');
        affectedCells++;
        return { kind: 'setFormula', sheet: operation.sheet, cell: operation.cell, formula: operation.formula };
      }
      if (operation.kind === 'appendRows') {
        if (!Array.isArray(operation.rows) || !operation.rows.length || operation.rows.length > this.limits.maxAppendRows) throw badRequest(`rows must contain between 1 and ${this.limits.maxAppendRows} rows`);
        const rows = operation.rows.map((row: unknown) => {
          if (!Array.isArray(row) || !row.length || row.some(cell => !scalar(cell, this.limits.maxCellCharacters))) throw badRequest('each appended row must contain valid bounded cell values');
          affectedCells += row.length;
          return row as SpreadsheetScalar[];
        });
        return { kind: 'appendRows', sheet: operation.sheet, rows };
      }
      throw badRequest('unsupported spreadsheet operation');
    }).map(operation => {
      if (affectedCells > this.limits.maxCells) throw badRequest(`spreadsheet operation exceeds ${this.limits.maxCells} cells`);
      return operation;
    });
  }

  private apply(workbook: ExcelJS.Workbook, operation: SpreadsheetOperation): void {
    if (operation.kind === 'addSheet') {
      if (workbook.worksheets.some(sheet => sheet.name.toLocaleLowerCase('en-US') === operation.name.toLocaleLowerCase('en-US'))) throw badRequest(`worksheet already exists: ${operation.name}`);
      workbook.addWorksheet(operation.name);
      return;
    }
    const sheet = workbook.getWorksheet(operation.sheet);
    if (!sheet) throw notFound(`worksheet not found: ${operation.sheet}`);
    if (operation.kind === 'setCell') { const coordinate = parseCellAddress(operation.cell); sheet.getCell(coordinate.row, coordinate.column).value = operation.value; return; }
    if (operation.kind === 'setFormula') { const coordinate = parseCellAddress(operation.cell); sheet.getCell(coordinate.row, coordinate.column).value = { formula: operation.formula.replace(/^=/, '') }; return; }
    operation.rows.forEach(row => sheet.addRow(row));
  }

  private assertSupportedPackage(content: Uint8Array): void {
    let zip: PizZip;
    try { zip = new PizZip(Buffer.from(content)); }
    catch { throw badRequest('invalid or unsupported .xlsx workbook'); }
    const entries = Object.keys(zip.files).map(name => name.toLowerCase());
    if (entries.some(name => name === 'xl/vbaproject.bin' || name.startsWith('xl/externallinks/') || name === 'xl/connections.xml')) {
      throw badRequest('workbooks containing macros, external workbook links, or external data connections are not supported');
    }
  }
}
