import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { diffLines } from 'diff';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import type { FileStorage } from '../domain/managed-file.js';
import { badRequest } from '../shared/app-error.js';

export type ExtractedDocument = { fileId: string; fileName: string; format: 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'text'; text: string; warnings: string[] };
export type DocumentDiff = { leftFileId: string; rightFileId: string; added: string[]; removed: string[]; unchangedLines: number };

const MAX_EXTRACTED_CHARACTERS = 200_000;
const MAX_WORKSHEETS = 50;
const MAX_WORKSHEET_ROWS = 500;
const MAX_WORKSHEET_COLUMNS = 100;
const MAX_PRESENTATION_SLIDES = 200;

function boundExtractedText(text: string): { text: string; truncated: boolean } {
  const truncated = text.length > MAX_EXTRACTED_CHARACTERS;
  return { text: truncated ? text.slice(0, MAX_EXTRACTED_CHARACTERS) : text, truncated };
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const number = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code.toLowerCase()] ?? entity;
  });
}

async function extractSpreadsheet(content: Uint8Array): Promise<{ text: string; truncated: boolean }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(content) as never);
  const lines: string[] = [];
  let characterCount = 0;
  let processedRows = 0;
  let truncated = workbook.worksheets.length > MAX_WORKSHEETS;
  for (const worksheet of workbook.worksheets.slice(0, MAX_WORKSHEETS)) {
    lines.push(`Sheet: ${worksheet.name}`);
    const rowCount = Math.min(worksheet.rowCount, MAX_WORKSHEET_ROWS);
    const columnCount = Math.min(worksheet.columnCount, MAX_WORKSHEET_COLUMNS);
    if (worksheet.rowCount > rowCount || worksheet.columnCount > columnCount) truncated = true;
    for (let rowNumber = 1; rowNumber <= rowCount && processedRows < MAX_WORKSHEET_ROWS; rowNumber++) {
      const values: string[] = [];
      for (let column = 1; column <= columnCount; column++) {
        const cell = worksheet.getCell(rowNumber, column);
        const value = cell.text.trim();
        if (value) values.push(`${cell.address}=${value}`);
        if (characterCount + values.join('\t').length > MAX_EXTRACTED_CHARACTERS) {
          truncated = true;
          break;
        }
      }
      if (values.length) {
        const line = values.join('\t');
        lines.push(line);
        characterCount += line.length;
      }
      processedRows++;
      if (characterCount >= MAX_EXTRACTED_CHARACTERS) break;
    }
    if (processedRows >= MAX_WORKSHEET_ROWS || characterCount >= MAX_EXTRACTED_CHARACTERS) {
      truncated = true;
      break;
    }
  }
  return { text: lines.join('\n').slice(0, MAX_EXTRACTED_CHARACTERS), truncated };
}

function extractPresentation(content: Uint8Array): { text: string; truncated: boolean } {
  const archive = new PizZip(Buffer.from(content));
  const slides = Object.keys(archive.files)
    .map(name => ({ name, match: name.match(/^ppt\/slides\/slide(\d+)\.xml$/) }))
    .filter((entry): entry is { name: string; match: RegExpMatchArray } => Boolean(entry.match))
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  const lines: string[] = [];
  let characterCount = 0;
  const truncated = slides.length > MAX_PRESENTATION_SLIDES;
  for (const [index, slide] of slides.slice(0, MAX_PRESENTATION_SLIDES).entries()) {
    const xml = archive.file(slide.name)?.asText() ?? '';
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map(match => decodeXmlText(match[1] ?? ''))
      .join('');
    if (!text.trim()) continue;
    const line = `Slide ${index + 1}: ${text}`;
    lines.push(line);
    characterCount += line.length;
    if (characterCount >= MAX_EXTRACTED_CHARACTERS) break;
  }
  return { text: lines.join('\n').slice(0, MAX_EXTRACTED_CHARACTERS), truncated: truncated || characterCount >= MAX_EXTRACTED_CHARACTERS };
}

export class DocumentContentService {
  constructor(private readonly files: FileStorage) {}
  async extract(fileId: string): Promise<ExtractedDocument> {
    const source = await this.files.read(fileId); const name = source.metadata.name.toLowerCase();
    if (name.endsWith('.docx')) {
      let result: Awaited<ReturnType<typeof mammoth.extractRawText>>;
      try { result = await mammoth.extractRawText({ buffer: Buffer.from(source.content) }); }
      catch { throw badRequest('invalid or unsupported .docx document'); }
      const bounded = boundExtractedText(result.value);
      return { fileId, fileName: source.metadata.name, format: 'docx', text: bounded.text, warnings: [...result.messages.map(message => message.message), ...(bounded.truncated ? ['Document text was truncated to keep extraction bounded.'] : [])] };
    }
    if (name.endsWith('.pdf')) {
      const parser = new PDFParse({ data: Buffer.from(source.content) });
      try {
        const result = await parser.getText();
        const bounded = boundExtractedText(result.text);
        return { fileId, fileName: source.metadata.name, format: 'pdf', text: bounded.text, warnings: bounded.truncated ? ['Document text was truncated to keep extraction bounded.'] : [] };
      } catch { throw badRequest('invalid or unsupported .pdf document'); }
      finally { await parser.destroy().catch(() => undefined); }
    }
    if (name.endsWith('.xlsx')) {
      let result: Awaited<ReturnType<typeof extractSpreadsheet>>;
      try { result = await extractSpreadsheet(source.content); }
      catch { throw badRequest('invalid or unsupported .xlsx workbook'); }
      return { fileId, fileName: source.metadata.name, format: 'xlsx', text: result.text, warnings: result.truncated ? ['Spreadsheet text was truncated to keep extraction bounded.'] : [] };
    }
    if (name.endsWith('.pptx')) {
      let result: ReturnType<typeof extractPresentation>;
      try { result = extractPresentation(source.content); }
      catch { throw badRequest('invalid or unsupported .pptx presentation'); }
      return { fileId, fileName: source.metadata.name, format: 'pptx', text: result.text, warnings: result.truncated ? ['Presentation text was truncated to keep extraction bounded.'] : [] };
    }
    if (name.endsWith('.txt') || source.metadata.mimeType.startsWith('text/')) {
      const bounded = boundExtractedText(Buffer.from(source.content).toString('utf8'));
      return { fileId, fileName: source.metadata.name, format: 'text', text: bounded.text, warnings: bounded.truncated ? ['Document text was truncated to keep extraction bounded.'] : [] };
    }
    throw badRequest('supported formats are .docx, .pdf, .xlsx, .pptx, and text files');
  }
  async compare(leftFileId: string, rightFileId: string): Promise<DocumentDiff> {
    const [left, right] = await Promise.all([this.extract(leftFileId), this.extract(rightFileId)]);
    const lines = diffLines(left.text, right.text); const added: string[] = []; const removed: string[] = []; let unchangedLines = 0;
    for (const part of lines) { const values = part.value.split('\n').filter(Boolean); if (part.added) added.push(...values); else if (part.removed) removed.push(...values); else unchangedLines += values.length; }
    return { leftFileId, rightFileId, added, removed, unchangedLines };
  }
}
