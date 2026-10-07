import {
  AlignmentType,
  BorderStyle,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  type FileChild
} from 'docx'

const CONTENT_WIDTH_DXA = 9746
const border = { style: BorderStyle.SINGLE, size: 4, color: 'D7DED8' }
const borders = {
  top: border,
  bottom: border,
  left: border,
  right: border,
  insideHorizontal: border,
  insideVertical: border
}

function cellsFromRow(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let escaped = false
  let inCode = false
  for (const character of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (character === '`' && !escaped) inCode = !inCode
    if (character === '|' && !escaped && !inCode) {
      cells.push(cell.trim().replace(/\\\|/g, '|'))
      cell = ''
    } else cell += character
    escaped = character === '\\' && !escaped
    if (character !== '\\') escaped = false
  }
  cells.push(cell.trim().replace(/\\\|/g, '|'))
  return cells
}

function inlineRuns(value: string, bold = false): TextRun[] {
  const runs: TextRun[] = []
  const pattern =
    /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu
  let offset = 0
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > offset)
      runs.push(new TextRun({ text: value.slice(offset, start), bold }))
    if (match[1] ?? match[2])
      runs.push(new TextRun({ text: match[1] ?? match[2]!, bold: true }))
    else if (match[3] ?? match[4])
      runs.push(
        new TextRun({ text: match[3] ?? match[4]!, bold, italics: true })
      )
    else if (match[5])
      runs.push(
        new TextRun({
          text: match[5],
          bold,
          font: 'Consolas',
          shading: { type: ShadingType.CLEAR, fill: 'F1F2EE' }
        })
      )
    else
      runs.push(
        new TextRun({
          text: `${match[6]} (${match[7]})`,
          bold,
          color: '27644F',
          underline: {}
        })
      )
    offset = start + match[0].length
  }
  if (offset < value.length || !runs.length)
    runs.push(new TextRun({ text: value.slice(offset), bold }))
  return runs
}

function makeTable(lines: string[]): Table {
  const sourceRows = lines.map(cellsFromRow)
  const columns = Math.max(1, ...sourceRows.map((row) => row.length))
  const divider = sourceRows[1] ?? []
  const alignment = Array.from({ length: columns }, (_, index) => {
    const cell = divider[index] ?? '---'
    return cell.startsWith(':') && cell.endsWith(':')
      ? AlignmentType.CENTER
      : cell.endsWith(':')
        ? AlignmentType.RIGHT
        : AlignmentType.LEFT
  })
  const width = Math.floor(CONTENT_WIDTH_DXA / columns)
  const columnWidths = Array.from({ length: columns }, (_, index) =>
    index === columns - 1 ? CONTENT_WIDTH_DXA - width * (columns - 1) : width
  )
  const rows = [sourceRows[0] ?? [], ...sourceRows.slice(2)].map(
    (row, rowIndex) =>
      new TableRow({
        tableHeader: rowIndex === 0,
        cantSplit: true,
        children: Array.from(
          { length: columns },
          (_, columnIndex) =>
            new TableCell({
              width: { size: columnWidths[columnIndex]!, type: WidthType.DXA },
              verticalAlign: 'center',
              margins: { top: 100, bottom: 100, left: 120, right: 120 },
              shading: {
                type: ShadingType.CLEAR,
                fill:
                  rowIndex === 0 ? 'E9EFEA' : rowIndex % 2 ? 'FFFFFF' : 'F8F7F2'
              },
              children: [
                new Paragraph({
                  alignment: alignment[columnIndex],
                  spacing: { before: 0, after: 0, line: 276 },
                  children: inlineRuns(row[columnIndex] ?? '', rowIndex === 0)
                })
              ]
            })
        )
      })
  )
  return new Table({
    rows,
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
    borders,
    margins: { top: 100, bottom: 100, left: 120, right: 120 }
  })
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/

export function markdownToDocxBlocks(markdown: string): FileChild[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: FileChild[] = []
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!
    if (!line.trim()) {
      index += 1
      continue
    }
    if (
      line.includes('|') &&
      lines[index + 1] &&
      TABLE_DIVIDER.test(lines[index + 1]!)
    ) {
      const tableLines = [line, lines[index + 1]!]
      index += 2
      while (
        index < lines.length &&
        lines[index]!.trim() &&
        lines[index]!.includes('|')
      ) {
        tableLines.push(lines[index]!)
        index += 1
      }
      blocks.push(makeTable(tableLines))
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    const headingLevel = heading
      ? `Heading${Math.min(heading[1]!.length, 6)}`
      : undefined
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    const quote = /^>\s?(.*)$/.exec(line)
    const content =
      heading?.[2] ?? bullet?.[1] ?? numbered?.[1] ?? quote?.[1] ?? line
    blocks.push(
      new Paragraph({
        ...(headingLevel
          ? { heading: headingLevel as `Heading${1 | 2 | 3 | 4 | 5 | 6}` }
          : {}),
        ...(bullet ? { bullet: { level: 0 } } : {}),
        ...(numbered
          ? { numbering: { reference: 'report-numbering', level: 0 } }
          : {}),
        ...(quote ? { indent: { left: 360 } } : {}),
        spacing: { after: 160, line: 276 },
        children: inlineRuns(content)
      })
    )
    index += 1
  }
  return blocks
}
