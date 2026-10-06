import {
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  type FileChild,
} from 'docx';

const CONTENT_WIDTH_DXA = 9_746;
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D7DED8' };
const TABLE_BORDERS = {
  top: TABLE_BORDER,
  bottom: TABLE_BORDER,
  left: TABLE_BORDER,
  right: TABLE_BORDER,
  insideHorizontal: TABLE_BORDER,
  insideVertical: TABLE_BORDER,
};

function splitTableRow(line: string): string[] {
  const value = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  let codeTicks = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '`') {
      let end = index + 1;
      while (value[end] === '`') end += 1;
      const count = end - index;
      if (!codeTicks) codeTicks = count;
      else if (codeTicks === count) codeTicks = 0;
      cell += value.slice(index, end);
      index = end - 1;
      continue;
    }
    if (character === '\\' && !escaped) {
      escaped = true;
      cell += character;
      continue;
    }
    if (character === '|' && !escaped && !codeTicks) {
      cells.push(cell.trim().replace(/\\\|/g, '|'));
      cell = '';
    } else {
      cell += character;
    }
    escaped = false;
  }
  cells.push(cell.trim().replace(/\\\|/g, '|'));
  return cells;
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableAlignment(cell: string): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (cell.startsWith(':') && cell.endsWith(':')) return AlignmentType.CENTER;
  if (cell.endsWith(':')) return AlignmentType.RIGHT;
  return AlignmentType.LEFT;
}

function inlineRuns(value: string, bold = false): TextRun[] {
  const runs: TextRun[] = [];
  const token = /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\[([^\]]+)\]\(([^)]+)\)/gu;
  let offset = 0;
  for (const match of value.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > offset) runs.push(new TextRun({ text: value.slice(offset, index), bold }));
    if (match[1] !== undefined || match[2] !== undefined) {
      runs.push(new TextRun({ text: match[1] ?? match[2]!, bold: true }));
    } else if (match[3] !== undefined || match[4] !== undefined) {
      runs.push(new TextRun({ text: match[3] ?? match[4]!, bold, italics: true }));
    } else if (match[5] !== undefined) {
      runs.push(new TextRun({ text: match[5], bold, font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'F1F2EE' } }));
    } else if (match[6] !== undefined) {
      runs.push(new TextRun({ text: `${match[6]} (${match[7]})`, bold, color: '27644F', underline: {} }));
    } else {
      runs.push(new TextRun({ text: match[8]!, bold }));
    }
    offset = index + match[0].length;
  }
  if (offset < value.length || runs.length === 0) runs.push(new TextRun({ text: value.slice(offset), bold }));
  return runs;
}

function createTable(lines: string[]): Table {
  const sourceRows = lines.map(splitTableRow);
  const header = sourceRows[0] ?? [];
  const columnCount = Math.max(1, header.length, ...sourceRows.map((row) => row.length));
  const divider = sourceRows[1] ?? [];
  const alignments = Array.from({ length: columnCount }, (_, index) => tableAlignment(divider[index] ?? '---'));
  const dataRows = [header, ...sourceRows.slice(2)];
  const columnWidth = Math.floor(CONTENT_WIDTH_DXA / columnCount);
  const widths = Array.from({ length: columnCount }, (_, index) =>
    index === columnCount - 1 ? CONTENT_WIDTH_DXA - columnWidth * (columnCount - 1) : columnWidth,
  );
  const rows = dataRows.map((row, rowIndex) =>
    new TableRow({
      tableHeader: rowIndex === 0,
      cantSplit: true,
      children: Array.from({ length: columnCount }, (_, columnIndex) =>
        new TableCell({
          width: { size: widths[columnIndex]!, type: WidthType.DXA },
          verticalAlign: 'center',
          margins: { top: 100, bottom: 100, left: 120, right: 120 },
          shading: { type: ShadingType.CLEAR, fill: rowIndex === 0 ? 'E9EFEA' : rowIndex % 2 ? 'FFFFFF' : 'F8F7F2' },
          children: [
            new Paragraph({
              alignment: alignments[columnIndex],
              spacing: { before: 0, after: 0, line: 276 },
              children: inlineRuns(row[columnIndex] ?? '', rowIndex === 0),
            }),
          ],
        }),
      ),
    }),
  );
  return new Table({
    rows,
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: TABLE_BORDERS,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
  });
}

function paragraph(line: string): Paragraph {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading) {
    const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
    return new Paragraph({ heading: levels[heading[1]!.length - 1], children: inlineRuns(heading[2]!) });
  }
  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) return new Paragraph({ indent: { left: 360 }, spacing: { before: 80, after: 160 }, children: inlineRuns(quote[1]!, false).map((run) => run) });
  const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
  if (bullet) return new Paragraph({ bullet: { level: 0 }, spacing: { after: 80 }, children: inlineRuns(bullet[1]!) });
  const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
  if (numbered) return new Paragraph({ numbering: { reference: 'report-numbering', level: 0 }, spacing: { after: 80 }, children: inlineRuns(numbered[1]!) });
  if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) return new Paragraph({ border: { bottom: { ...TABLE_BORDER, space: 4 } }, spacing: { after: 160 } });
  return new Paragraph({ spacing: { after: line.trim() ? 160 : 0, line: 276 }, children: inlineRuns(line.replace(/ {2,}$/g, '')) });
}

export function markdownToDocxChildren(markdown: string): FileChild[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const children: FileChild[] = [];
  for (let index = 0; index < lines.length; ) {
    if (!lines[index]!.trim()) {
      index += 1;
      continue;
    }
    if (lines[index + 1] && lines[index]!.includes('|') && isTableDivider(lines[index + 1]!)) {
      const tableLines = [lines[index]!, lines[index + 1]!];
      index += 2;
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes('|')) {
        tableLines.push(lines[index]!);
        index += 1;
      }
      children.push(createTable(tableLines));
      continue;
    }
    children.push(paragraph(lines[index]!));
    index += 1;
  }
  return children;
}
