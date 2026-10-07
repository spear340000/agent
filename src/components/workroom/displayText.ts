const FRONT_MATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u

/** A second `---` block of `key: value` lines directly under the page's `# title`. */
const TITLE_THEN_METADATA =
  /^(#[^\r\n]*(?:\r?\n)+)---[ \t]*\r?\n(?=[^\r\n:]{1,30}:)[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u

const ESCAPED_UNICODE = /\\u([0-9a-fA-F]{4})/g

/**
 * Wiki sources carry YAML metadata (and a second metadata block under the title) plus literal unicode
 * escapes such as backslash-u AD50; show only the readable body.
 */
export function cleanWikiMarkdown(text: string): string {
  return text
    .replace(FRONT_MATTER, '')
    .replace(/^\s+/u, '')
    .replace(TITLE_THEN_METADATA, '$1')
    .replace(ESCAPED_UNICODE, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/^\s+/u, '')
}

/**
 * The page header already shows the title, so a matching first `# ` heading is blanked
 * (not removed, so heading line numbers used for highlighting stay valid).
 */
export function blankDuplicateTitle(markdown: string, title: string): string {
  const lines = markdown.split('\n')
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first < 0) return markdown
  const match = /^#\s+(.+?)\s*#*\s*$/u.exec(lines[first]!.replace(/\r$/u, ''))
  if (!match || match[1]!.trim() !== title.trim()) return markdown
  lines[first] = ''
  return lines.join('\n')
}

/** Raw runtime messages such as "signal timed out" must not reach the user. */
export function friendlyErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const name = error.name
  const message = error.message
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /timed out|timeout|aborted/i.test(message)
  ) {
    return '서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.'
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return '백엔드에 연결할 수 없습니다. 주소와 서버 실행 상태를 확인해 주세요.'
  }
  return message || fallback
}

/** Backend failure text for a task: known infrastructure errors become Korean guidance, anything else is kept. */
export function friendlyTaskError(message: string): string {
  if (/legal retrieval process is unavailable|legal retrieval process did not start|process exited/i.test(message)) {
    return '법령 검색 서버에 연결하지 못했습니다. 서버가 복구된 뒤 "다시 실행"을 눌러 주세요.'
  }
  if (/timed out|timeout/i.test(message)) {
    return '서버 응답이 지연되어 작업이 중단되었습니다. 잠시 후 "다시 실행"을 눌러 주세요.'
  }
  return message
}
