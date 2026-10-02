'use client'

import React, { useState } from 'react'
import { officeApi, type PdfInspection } from '@/api/automation'
import { FileField, ToolButton, type ToolProps } from './ToolFields'
import { parsePages } from './toolInputs'

export default function PdfTools({
  connection,
  files,
  busy,
  disabled,
  run
}: ToolProps) {
  const [operation, setOperation] = useState<
    'inspect' | 'merge' | 'split' | 'reorder' | 'removePages' | 'rotatePages'
  >('inspect')
  const [fileId, setFileId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [outputName, setOutputName] = useState('')
  const [pages, setPages] = useState('')
  const [degrees, setDegrees] = useState(90)
  const [inspection, setInspection] = useState<PdfInspection | null>(null)
  const pdfs = files.filter((file) => file.name.toLowerCase().endsWith('.pdf'))
  return (
    <form
      className="workfolio-tool-form"
      onSubmit={(event) => {
        event.preventDefault()
        void run('PDF 작업', async () => {
          if (operation === 'inspect') {
            const result = await officeApi.inspectPdf(connection, fileId)
            setInspection(result)
            return result
          }
          if (operation === 'merge')
            return officeApi.mergePdf(connection, {
              fileIds: selected,
              outputName
            })
          if (operation === 'split')
            return officeApi.splitPdf(connection, {
              fileId,
              pageNumbers: parsePages(pages),
              outputPrefix: outputName
            })
          return officeApi.editPdf(connection, {
            fileId,
            outputName,
            operation: {
              kind: operation,
              pageNumbers: parsePages(pages),
              ...(operation === 'rotatePages' ? { degrees } : {})
            }
          })
        })
      }}
    >
      <h2>PDF 작업</h2>
      <p>
        페이지 조회, 합치기, 분리, 순서 변경, 제거와 회전을 지원합니다. 암호화된
        파일은 처리하지 않습니다.
      </p>
      <label>
        작업
        <select
          value={operation}
          onChange={(event) => {
            setOperation(event.target.value as typeof operation)
            setInspection(null)
          }}
        >
          <option value="inspect">페이지 조회</option>
          <option value="merge">파일 합치기</option>
          <option value="split">페이지별 분리</option>
          <option value="reorder">페이지 순서 변경</option>
          <option value="removePages">페이지 제거</option>
          <option value="rotatePages">페이지 회전</option>
        </select>
      </label>
      {operation !== 'merge' ? (
        <FileField
          files={pdfs}
          value={fileId}
          onChange={(id) => {
            setFileId(id)
            setInspection(null)
          }}
        />
      ) : (
        <fieldset>
          <legend>합칠 파일 (선택한 순서로 처리)</legend>
          {pdfs.map((file) => (
            <label className="workfolio-checkbox" key={file.id}>
              <input
                type="checkbox"
                checked={selected.includes(file.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, file.id]
                      : current.filter((id) => id !== file.id)
                  )
                }
              />
              {selected.includes(file.id)
                ? `${selected.indexOf(file.id) + 1}. `
                : ''}
              {file.name}
            </label>
          ))}
          {!pdfs.length && <p>먼저 PDF 파일을 업로드하세요.</p>}
        </fieldset>
      )}
      {operation !== 'inspect' && (
        <label>
          {operation === 'split' ? '결과 파일 이름 접두사' : '결과 파일 이름'}
          <input
            required
            value={outputName}
            onChange={(event) => setOutputName(event.target.value)}
          />
        </label>
      )}
      {!['inspect', 'merge'].includes(operation) && (
        <label>
          {operation === 'reorder' ? '모든 페이지의 새 순서' : '대상 페이지'}
          <input
            required
            value={pages}
            onChange={(event) => setPages(event.target.value)}
            placeholder="1,3-5"
          />
        </label>
      )}
      {operation === 'rotatePages' && (
        <label>
          회전 각도
          <select
            value={degrees}
            onChange={(event) => setDegrees(Number(event.target.value))}
          >
            <option value={90}>90°</option>
            <option value={180}>180°</option>
            <option value={270}>270°</option>
          </select>
        </label>
      )}
      <ToolButton busy={busy} disabled={disabled} />
      {inspection && (
        <section className="workfolio-table-wrap" aria-label="PDF 조회 결과">
          <p>{inspection.pageCount}페이지</p>
          <table>
            <thead>
              <tr>
                <th>페이지</th>
                <th>크기 (pt)</th>
                <th>회전</th>
              </tr>
            </thead>
            <tbody>
              {inspection.pages.map((page) => (
                <tr key={page.number}>
                  <td>{page.number}</td>
                  <td>
                    {page.width} × {page.height}
                  </td>
                  <td>{page.rotation}°</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </form>
  )
}
