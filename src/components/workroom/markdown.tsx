import React from 'react'

export type MarkdownListItem = { text: string; level: number }
export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'rule' }

const HEADING = /^ {0,3}(#{1,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/
const UNORDERED = /^( {0,3})([-*+])[ \t]+(.+)$/
const ORDERED = /^( {0,3})(\d{1,9})[.)][ \t]+(.+)$/
const QUOTE = /^ {0,3}>[ \t]?(.*)$/
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/
const CITATION = /^\[([LPGDWT]\d{1,3})\]$/

function tableCells(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let escaped = false
  const source = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  for (const character of source) {
    if (escaped) {
      cell += character === '|' ? '|' : `\\${character}`
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  if (escaped) cell += '\\'
  cells.push(cell.trim())
  return cells
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  let paragraph: string[] = []
  let quote: string[] = []
  let list: { ordered: boolean; items: MarkdownListItem[] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }
  const flushQuote = (): void => {
    if (quote.length === 0) return
    blocks.push({ kind: 'quote', text: quote.join('\n') })
    quote = []
  }
  const flushList = (): void => {
    if (!list) return
    if (list.items.length > 0) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
    list = null
  }
  const flushAll = (): void => {
    flushParagraph()
    flushQuote()
    flushList()
  }

  while (index < lines.length) {
    const line = lines[index]!
    const fence = FENCE.exec(line)
    if (fence) {
      flushAll()
      const marker = fence[1]!
      const body: string[] = []
      index += 1
      while (index < lines.length) {
        const current = lines[index]!
        const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
        if (closing.test(current)) break
        body.push(current)
        index += 1
      }
      index += 1
      blocks.push({ kind: 'code', language: fence[2] ?? '', text: body.join('\n') })
      continue
    }
    if (line.trim() === '') {
      flushAll()
      index += 1
      continue
    }
    if (RULE.test(line)) {
      flushAll()
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }
    if (index + 1 < lines.length && line.includes('|')) {
      const headers = tableCells(line)
      const separators = tableCells(lines[index + 1]!)
      if (headers.length > 0 && separators.length === headers.length && separators.every(cell => /^:?-{3,}:?$/.test(cell))) {
        flushAll()
        const rows = [headers]
        index += 2
        while (index < lines.length && lines[index]!.trim() !== '' && lines[index]!.includes('|')) {
          const cells = tableCells(lines[index]!)
          rows.push(Array.from({ length: headers.length }, (_, column) => cells[column] ?? ''))
          index += 1
        }
        blocks.push({ kind: 'table', rows })
        continue
      }
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushAll()
      blocks.push({
        kind: 'heading',
        level: Math.min(heading[1]!.length, 4) as 1 | 2 | 3 | 4,
        text: heading[2]!.trim()
      })
      index += 1
      continue
    }
    const quoteLine = QUOTE.exec(line)
    if (quoteLine) {
      flushParagraph()
      flushList()
      quote.push(quoteLine[1]!)
      index += 1
      continue
    }
    const unordered = UNORDERED.exec(line)
    const ordered = ORDERED.exec(line)
    if (unordered || ordered) {
      flushParagraph()
      flushQuote()
      const orderedItem = Boolean(ordered)
      if (!list || list.ordered !== orderedItem) {
        flushList()
        list = { ordered: orderedItem, items: [] }
      }
      const indent = (unordered?.[1] ?? ordered?.[1] ?? '').replace(/\t/g, '  ').length
      list.items.push({
        text: (unordered?.[3] ?? ordered?.[3] ?? '').trim(),
        level: Math.min(Math.floor(indent / 2), 2)
      })
      index += 1
      continue
    }
    flushQuote()
    flushList()
    paragraph.push(line)
    index += 1
  }
  flushAll()
  return blocks
}

const INLINE = new RegExp(
  [
    '(`+)([\\s\\S]*?)\\1',
    '\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)',
    '<(https?://[^>\\s]+)>',
    '(\\*\\*|__)(?=\\S)([\\s\\S]*?\\S)\\6',
    '(?<!\\*)\\*([^*\\n]+)\\*(?!\\*)',
    '\\[([LPGDWT]\\d{1,3})\\]'
  ].join('|'),
  'g'
)

const SAFE_URL = /^https?:\/\/[^\s"'<>]+$/i

export function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  let index = 0
  const pushText = (raw: string): void => {
    const hardBreak = /[ \t]{2,}\n[ \t]*$/.test(raw)
    const value = hardBreak ? raw.replace(/[ \t]{2,}\n[ \t]*$/, '\n') : raw
    nodes.push(value)
    if (hardBreak) nodes.push(<br key={`${keyPrefix}-br-${index++}`} />)
  }
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start < cursor) continue
    if (start > cursor) pushText(text.slice(cursor, start))
    const key = `${keyPrefix}-${index++}`
    if (match[2] !== undefined) {
      nodes.push(<code key={key}>{match[2]}</code>)
    } else if (match[3] !== undefined) {
      const label = match[3]!
      const href = match[4]!
      nodes.push(
        SAFE_URL.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        )
      )
    } else if (match[5] !== undefined) {
      nodes.push(
        <a key={key} href={match[5]!} target="_blank" rel="noreferrer noopener">
          {match[5]}
        </a>
      )
    } else if (match[6] !== undefined) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(match[7] ?? '', key)}</strong>)
    } else if (match[8] !== undefined) {
      nodes.push(<em key={key}>{match[8]}</em>)
    } else if (CITATION.test(match[0]!)) {
      const id = match[9]!
      nodes.push(
        <cite key={key} className="md-citation" title={`근거 ${id}`}>
          {id}
        </cite>
      )
    } else {
      nodes.push(match[0])
    }
    cursor = start + match[0].length
  }
  if (cursor < text.length) pushText(text.slice(cursor))
  return nodes
}
