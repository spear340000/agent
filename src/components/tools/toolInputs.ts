export function parsePages(value: string): number[] {
  const pages: number[] = []
  for (const part of value.split(',').map((item) => item.trim())) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part)
    if (!match) throw new Error('페이지는 1,3-5 형식으로 입력하세요.')
    const start = Number(match[1]),
      end = Number(match[2] ?? match[1])
    if (
      start < 1 ||
      end < start ||
      end > 2000 ||
      pages.length + end - start + 1 > 2000
    )
      throw new Error('페이지 범위는 1~2000 사이여야 합니다.')
    for (let page = start; page <= end; page++) pages.push(page)
  }
  if (new Set(pages).size !== pages.length)
    throw new Error('같은 페이지를 중복 입력할 수 없습니다.')
  return pages
}

// RFC 4180 quoting, including pasted Excel TSV and embedded line breaks.
export function parseRows(text: string, delimiter: ',' | '\t'): string[][] {
  if (!text.trim()) throw new Error('추가할 행을 입력하세요.')
  if (text.length > 1_000_000) throw new Error('행 데이터가 너무 큽니다.')
  const rows: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false,
    endedQuote = false
  const finishCell = () => {
    row.push(cell)
    cell = ''
    endedQuote = false
  }
  const finishRow = () => {
    finishCell()
    rows.push(row)
    row = []
    if (rows.length > 10_000)
      throw new Error('행은 최대 10000개까지 가능합니다.')
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index++
        } else {
          quoted = false
          endedQuote = true
        }
      } else cell += char
    } else if (char === '"') {
      if (cell || endedQuote) throw new Error('잘못된 CSV 따옴표입니다.')
      quoted = true
    } else if (char === delimiter) finishCell()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      finishRow()
    } else {
      if (endedQuote)
        throw new Error('따옴표 뒤에는 구분자나 줄바꿈만 허용됩니다.')
      cell += char
    }
  }
  if (quoted) throw new Error('CSV 따옴표를 닫아 주세요.')
  if (cell || row.length || endedQuote) finishRow()
  if (rows.reduce((count, item) => count + item.length, 0) > 100_000)
    throw new Error('셀은 최대 100000개까지 가능합니다.')
  return rows
}
