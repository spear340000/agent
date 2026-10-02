export type DocumentHeading = {
  level: 1 | 2 | 3 | 4 | 5 | 6
  title: string
  line: number
  start: number
}

export type DocumentCommand =
  | 'heading1'
  | 'heading2'
  | 'bold'
  | 'bullet'
  | 'quote'

export type DocumentEditResult = {
  value: string
  selectionStart: number
  selectionEnd: number
}

type SaveState = { dirty: boolean; saving: boolean; error: string | null }
type SaveStatus = 'error' | 'saving' | 'unsaved' | 'saved'

export function getDocumentOutline(markdown: string): DocumentHeading[] {
  const headings: DocumentHeading[] = []
  const lines = markdown.split(/\r\n|\n|\r/)
  let offset = 0
  let fence: { character: string; length: number } | null = null

  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      const rest = fenceMatch[2]
      if (!fence) {
        if (marker[0] !== '`' || !rest.includes('`')) {
          fence = { character: marker[0], length: marker.length }
        }
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        /^\s*$/.test(rest)
      ) {
        fence = null
      }
    } else if (!fence) {
      const match = line.match(/^( {0,3})(#{1,6})(?:[ \t]+(.*?)[ \t]*|[ \t]*)$/)
      if (match) {
        const title = (match[3] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
        headings.push({
          level: match[2].length as DocumentHeading['level'],
          title,
          line: index + 1,
          start: offset + match[1].length
        })
      }
    }

    offset += line.length
    if (offset < markdown.length) {
      if (markdown.startsWith('\r\n', offset)) offset += 2
      else offset += 1
    }
  })

  return headings
}

const NON_DOCUMENT_SECTIONS = /^(?:요청|요청 내용|사용자 요청|초안 구조(?: 예시)?|문서 구조(?: 예시)?|구성 예시)$/iu

export function prepareFinalDocument(markdown: string, title: string): string {
  const lines = markdown.split(/\r\n|\n|\r/u)
  const headings = getDocumentOutline(markdown)
  const omittedLines = new Set<number>()

  headings.forEach((heading, index) => {
    if (!NON_DOCUMENT_SECTIONS.test(heading.title.trim())) return
    const nextSection = headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level)
    const firstLine = heading.line - 1
    const afterLastLine = nextSection ? nextSection.line - 1 : lines.length
    for (let line = firstLine; line < afterLastLine; line += 1) {
      omittedLines.add(line)
    }
  })

  const cleaned = lines
    .filter((line, index) => {
      if (omittedLines.has(index)) return false
      return true
    })
    .join('\n')
    .replace(/\n(?:[\t ]*\n){2,}/gu, '\n\n')
    .trim()
  if (!cleaned) return `# ${title.trim()}`

  const hasTitleHeading = getDocumentOutline(cleaned).some(
    (heading) => heading.level === 1
  )
  return hasTitleHeading || !title.trim()
    ? cleaned
    : `# ${title.trim()}\n\n${cleaned}`
}

function clampOffset(markdown: string, offset: number): number {
  if (!Number.isFinite(offset)) return 0
  return Math.max(0, Math.min(markdown.length, Math.trunc(offset)))
}

function lineStartAt(markdown: string, offset: number): number {
  return markdown.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
}

function lineEndAt(markdown: string, start: number): number {
  const newline = /[\r\n]/g
  newline.lastIndex = start
  const match = newline.exec(markdown)
  return match?.index ?? markdown.length
}

function nextLineStart(markdown: string, end: number): number {
  if (markdown.startsWith('\r\n', end)) return end + 2
  if (markdown[end] === '\r' || markdown[end] === '\n') return end + 1
  return markdown.length + 1
}

function normalizeSelection(
  markdown: string,
  selectionStart: number,
  selectionEnd: number
): [number, number] {
  const start = clampOffset(markdown, selectionStart)
  const end = clampOffset(markdown, selectionEnd)
  return start <= end ? [start, end] : [end, start]
}

function applyHeading(
  markdown: string,
  selectionStart: number,
  selectionEnd: number,
  level: 1 | 2
): DocumentEditResult {
  const lineStart = lineStartAt(markdown, selectionStart)
  const lineEnd = lineEndAt(markdown, lineStart)
  const line = markdown.slice(lineStart, lineEnd)
  const indent = line.match(/^ {0,3}/)?.[0] ?? ''
  const previousPrefix = line.match(/^ {0,3}#{1,6}(?:[ \t]+|$)/)?.[0]
  const oldPrefixLength = previousPrefix?.length ?? indent.length
  const title = line.slice(oldPrefixLength).replace(/[ \t]+#+[ \t]*$/, '')
  const prefix = `${indent}${'#'.repeat(level)} `
  const value = `${markdown.slice(0, lineStart)}${prefix}${title}${markdown.slice(lineEnd)}`
  const delta = prefix.length - oldPrefixLength

  const mapOffset = (offset: number): number => {
    if (offset <= lineStart) return offset
    if (offset >= lineStart + oldPrefixLength) return offset + delta
    return lineStart + Math.min(offset - lineStart, prefix.length)
  }

  return {
    value,
    selectionStart: mapOffset(selectionStart),
    selectionEnd: mapOffset(selectionEnd)
  }
}

function applyInline(
  markdown: string,
  selectionStart: number,
  selectionEnd: number
): DocumentEditResult {
  const selected = markdown.slice(selectionStart, selectionEnd)
  const value = `${markdown.slice(0, selectionStart)}**${selected}**${markdown.slice(selectionEnd)}`
  return {
    value,
    selectionStart: selectionStart + 2,
    selectionEnd: selectionEnd + 2
  }
}

function applyLinePrefix(
  markdown: string,
  selectionStart: number,
  selectionEnd: number,
  prefix: '- ' | '> '
): DocumentEditResult {
  const firstLineStart = lineStartAt(markdown, selectionStart)
  const hasSelection = selectionStart !== selectionEnd
  const lastSelectedCharacter = hasSelection ? selectionEnd - 1 : selectionStart
  const lastLineStart = lineStartAt(markdown, lastSelectedCharacter)
  const offsets: number[] = []

  for (let start = firstLineStart; start <= lastLineStart; ) {
    const end = lineEndAt(markdown, start)
    const indentLength =
      markdown.slice(start, end).match(/^ */)?.[0].length ?? 0
    offsets.push(start + indentLength)
    const next = nextLineStart(markdown, end)
    if (next > lastLineStart || next > markdown.length) break
    start = next
  }

  let value = markdown
  for (const offset of offsets.toReversed()) {
    value = `${value.slice(0, offset)}${prefix}${value.slice(offset)}`
  }

  const mapStart = (offset: number): number =>
    offset +
    offsets.filter((insertion) => insertion <= offset).length * prefix.length
  const mapEnd = (offset: number): number =>
    offset +
    offsets.filter((insertion) => insertion < offset).length * prefix.length

  return {
    value,
    selectionStart: mapStart(selectionStart),
    selectionEnd: hasSelection ? mapEnd(selectionEnd) : mapStart(selectionEnd)
  }
}

export function applyDocumentCommand(
  markdown: string,
  selectionStart: number,
  selectionEnd: number,
  command: DocumentCommand
): DocumentEditResult {
  const [start, end] = normalizeSelection(
    markdown,
    selectionStart,
    selectionEnd
  )

  switch (command) {
    case 'heading1':
      return applyHeading(markdown, start, end, 1)
    case 'heading2':
      return applyHeading(markdown, start, end, 2)
    case 'bold':
      return applyInline(markdown, start, end)
    case 'bullet':
      return applyLinePrefix(markdown, start, end, '- ')
    case 'quote':
      return applyLinePrefix(markdown, start, end, '> ')
  }
}

export function getDocumentSaveStatus(state: SaveState): SaveStatus {
  if (state.error) return 'error'
  if (state.saving) return 'saving'
  if (state.dirty) return 'unsaved'
  return 'saved'
}
