import React, { useEffect, useMemo, useState } from 'react'
import MarkdownView from './MarkdownView'

export type DocumentFormat = 'md' | 'docx' | 'xlsx' | 'pdf'

type Sheet = { name: string; rows: string[][] }

async function readZipEntry(
  bytes: Uint8Array,
  view: DataView,
  target: string
): Promise<string | null> {
  let endRecord = -1
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endRecord = offset
      break
    }
  }
  if (endRecord < 0) throw new Error('Excel 파일 구조를 읽지 못했습니다.')
  const entries = view.getUint16(endRecord + 10, true)
  let cursor = view.getUint32(endRecord + 16, true)
  const decoder = new TextDecoder()
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    )
    if (name === target) {
      const localNameLength = view.getUint16(localOffset + 26, true)
      const localExtraLength = view.getUint16(localOffset + 28, true)
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength
      const compressed = bytes.slice(dataOffset, dataOffset + compressedSize)
      if (method === 0) return decoder.decode(compressed)
      if (method !== 8) throw new Error('지원하지 않는 Excel 압축 형식입니다.')
      const stream = new Blob([compressed]).stream().pipeThrough(
        new DecompressionStream('deflate-raw')
      )
      return decoder.decode(await new Response(stream).arrayBuffer())
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return null
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A'
  return [...letters].reduce(
    (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
    0
  ) - 1
}

async function readWorkbook(blob: Blob): Promise<Sheet[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const workbookText = await readZipEntry(bytes, view, 'xl/workbook.xml')
  const relationsText = await readZipEntry(
    bytes,
    view,
    'xl/_rels/workbook.xml.rels'
  )
  if (!workbookText || !relationsText)
    throw new Error('Excel 시트 정보를 찾지 못했습니다.')
  const parser = new DOMParser()
  const workbook = parser.parseFromString(workbookText, 'application/xml')
  const relations = parser.parseFromString(relationsText, 'application/xml')
  const targets = new Map(
    Array.from(relations.getElementsByTagName('Relationship')).map((item) => [
      item.getAttribute('Id') ?? '',
      item.getAttribute('Target') ?? ''
    ])
  )
  const sharedText = await readZipEntry(bytes, view, 'xl/sharedStrings.xml')
  const sharedStrings = sharedText
    ? Array.from(
        parser
          .parseFromString(sharedText, 'application/xml')
          .getElementsByTagName('si')
      ).map((item) => item.textContent ?? '')
    : []
  const sheets: Sheet[] = []
  for (const sheet of Array.from(workbook.getElementsByTagName('sheet'))) {
    const relationId = sheet.getAttribute('r:id') ?? ''
    const target = targets.get(relationId)
    if (!target) continue
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`
    const sheetText = await readZipEntry(bytes, view, path)
    if (!sheetText) continue
    const xml = parser.parseFromString(sheetText, 'application/xml')
    const rows = Array.from(xml.getElementsByTagName('row'))
      .slice(0, 500)
      .map((row) => {
        const cells: string[] = []
        for (const cell of Array.from(row.getElementsByTagName('c'))) {
          const index = columnIndex(cell.getAttribute('r') ?? 'A1')
          const value = cell.getElementsByTagName('v')[0]?.textContent ?? ''
          const type = cell.getAttribute('t')
          cells[index] =
            type === 's'
              ? sharedStrings[Number(value)] ?? ''
              : type === 'inlineStr'
                ? cell.getElementsByTagName('is')[0]?.textContent ?? ''
                : value
        }
        return cells
      })
    sheets.push({ name: sheet.getAttribute('name') ?? '시트', rows })
  }
  return sheets
}

function columnName(index: number): string {
  let value = index + 1
  let name = ''
  while (value > 0) {
    value -= 1
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26)
  }
  return name
}

export default function DocumentFormatPreview({
  format,
  markdown,
  file
}: {
  format: DocumentFormat
  markdown: string
  file: Blob | null
}) {
  const [pdfUrl, setPdfUrl] = useState('')
  const [sheets, setSheets] = useState<Sheet[]>([])
  const [sheetError, setSheetError] = useState('')
  const [activeSheet, setActiveSheet] = useState(0)

  useEffect(() => {
    if (format !== 'pdf' || !file) {
      setPdfUrl('')
      return
    }
    const url = URL.createObjectURL(
      new Blob([file], { type: 'application/pdf' })
    )
    setPdfUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [format, file])

  useEffect(() => {
    if (format !== 'xlsx' || !file) {
      setSheets([])
      setSheetError('')
      setActiveSheet(0)
      return
    }
    let cancelled = false
    void readWorkbook(file)
      .then((nextSheets) => {
        if (!cancelled) {
          setSheets(nextSheets)
          setActiveSheet(0)
          setSheetError('')
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setSheetError(
            cause instanceof Error
              ? cause.message
              : 'Excel 미리보기를 읽지 못했습니다.'
          )
      })
    return () => {
      cancelled = true
    }
  }, [format, file])

  const rows = useMemo(
    () => sheets[activeSheet]?.rows ?? [],
    [activeSheet, sheets]
  )

  if (format === 'pdf') {
    return pdfUrl ? (
      <iframe
        className="document-format-preview__pdf"
        src={pdfUrl}
        title="PDF 문서 미리보기"
      />
    ) : null
  }

  if (format === 'xlsx') {
    if (sheetError) return <p role="alert">{sheetError}</p>
    if (!sheets.length)
      return <p role="status">Excel 미리보기를 불러오는 중입니다…</p>
    return (
      <section className="document-format-preview document-format-preview--excel">
        {sheets.length > 1 && (
          <nav
            className="document-format-preview__sheets"
            aria-label="Excel 시트"
          >
            {sheets.map((sheet, index) => (
              <button
                type="button"
                key={`${sheet.name}-${index}`}
                aria-pressed={activeSheet === index}
                onClick={() => setActiveSheet(index)}
              >
                {sheet.name}
              </button>
            ))}
          </nav>
        )}
        <div
          className="document-format-preview__grid-wrap"
          role="region"
          aria-label="Excel 형식 미리보기"
          tabIndex={0}
        >
          <table className="document-format-preview__grid">
            <thead>
              <tr>
                <th aria-label="행 번호" />
                {Array.from(
                  { length: Math.max(1, ...rows.map((row) => row.length)) },
                  (_, index) => (
                    <th key={index}>{columnName(index)}</th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th scope="row">{rowIndex + 1}</th>
                  {Array.from(
                    { length: Math.max(1, ...rows.map((item) => item.length)) },
                    (_, columnIndex) => (
                      <td key={columnIndex}>{row[columnIndex] ?? ''}</td>
                    )
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length >= 500 && (
          <p className="document-format-preview__note">
            시트는 처음 500행까지만 표시합니다.
          </p>
        )}
      </section>
    )
  }

  return (
    <div
      className={`document-format-preview document-format-preview--${format}`}
    >
      {format === 'docx' && (
        <p className="document-format-preview__note">
          Word 화면 미리보기입니다. 페이지 나눔과 글꼴은 Word에서 다를 수
          있습니다.
        </p>
      )}
      <MarkdownView value={markdown} />
    </div>
  )
}
