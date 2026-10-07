'use client'

import React, { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import Image from 'next/image'
import { officeApi, type PdfInspection } from '@/api/automation'
import { FileField, ToolButton, type ToolProps } from './ToolFields'
import { parsePages } from './toolInputs'
import {
  PDF_PAGE_WINDOW_SIZE,
  pdfPageWindow,
  presentPdfPage
} from './pdfPagePresentation'

export default function PdfTools({
  connection,
  files,
  filesLoading = false,
  busy,
  disabled,
  run
}: ToolProps) {
  const { baseUrl, token } = connection
  const [operation, setOperation] = useState<
    'inspect' | 'merge' | 'split' | 'reorder' | 'removePages' | 'rotatePages'
  >('inspect')
  const [fileId, setFileId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [outputName, setOutputName] = useState('')
  const [pages, setPages] = useState('')
  const [degrees, setDegrees] = useState(90)
  const [inspection, setInspection] = useState<PdfInspection | null>(null)
  const [pageWindowStart, setPageWindowStart] = useState(0)
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({})
  const [thumbnailLoading, setThumbnailLoading] = useState(false)
  const [thumbnailError, setThumbnailError] = useState('')
  const pdfs = files.filter((file) => file.name.toLowerCase().endsWith('.pdf'))
  const pageSelectionDisabled = operation === 'inspect' || operation === 'merge'
  const requestedPages = inspection
    ? inspection.pages.slice(
        pageWindowStart,
        pageWindowStart + PDF_PAGE_WINDOW_SIZE
      )
    : []
  const thumbnailPageKey = requestedPages.map((page) => page.number).join(',')

  useEffect(() => {
    if (!fileId || !thumbnailPageKey) return
    let cancelled = false
    const pageNumbers = thumbnailPageKey.split(',').map(Number)
    setThumbnails({})
    setThumbnailError('')
    setThumbnailLoading(true)
    void officeApi
      .pdfThumbnails({ baseUrl, token }, { fileId, pageNumbers })
      .then((result) => {
        if (cancelled) return
        setThumbnails(
          Object.fromEntries(
            result.pages.map((page) => [page.pageNumber, page.dataBase64])
          )
        )
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setThumbnailError(
            cause instanceof Error
              ? cause.message
              : '페이지 미리보기를 불러오지 못했습니다.'
          )
      })
      .finally(() => {
        if (!cancelled) setThumbnailLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [baseUrl, token, fileId, thumbnailPageKey])
  const selectedPages = (() => {
    try {
      return pages ? parsePages(pages) : []
    } catch {
      return []
    }
  })()
  return (
    <>
      <form
        className="workfolio-tool-form workfolio-pdf-form"
        onSubmit={(event) => {
          event.preventDefault()
          void run('PDF 작업', async () => {
            if (operation === 'inspect') {
              const result = await officeApi.inspectPdf(connection, fileId)
              setInspection(result)
              setPageWindowStart(0)
              return undefined
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
          페이지 조회, 합치기, 분리, 순서 변경, 제거와 회전을 지원합니다.
          암호화된 파일은 처리하지 않습니다.
        </p>
        <label>
          작업
          <select
            value={operation}
            onChange={(event) => {
              setOperation(event.target.value as typeof operation)
              setPages('')
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
            loading={filesLoading}
            emptyMessage="PDF 파일이 없습니다. 상단에서 .pdf 파일을 업로드해 주세요."
            onChange={(id) => {
              setFileId(id)
              setInspection(null)
              setPages('')
              setPageWindowStart(0)
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
            {!pdfs.length && (
              <p role="status">
                {filesLoading
                  ? '파일 목록을 불러오는 중입니다.'
                  : 'PDF 파일이 없습니다. 상단에서 .pdf 파일을 업로드해 주세요.'}
              </p>
            )}
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
        <ToolButton
          busy={busy}
          disabled={
            disabled ||
            !pdfs.length ||
            (operation === 'merge' && selected.length < 2)
          }
        />
      </form>
      {inspection && (
        <section
          className="workfolio-pdf-preview"
          aria-label="PDF 페이지 미리보기"
        >
          <div className="workfolio-pdf-preview__heading">
            <div>
              <h3>페이지 구성</h3>
              <p>{inspection.pageCount}페이지 · 실제 페이지 크기와 방향</p>
            </div>
            {!pageSelectionDisabled && <span>페이지를 누르면 선택돼요</span>}
          </div>
          {inspection.pageCount > PDF_PAGE_WINDOW_SIZE && (
            <nav
              className="workfolio-pdf-page-window"
              aria-label="PDF 페이지 범위"
            >
              <button
                type="button"
                disabled={pageWindowStart === 0}
                onClick={() =>
                  setPageWindowStart((current) =>
                    Math.max(0, current - PDF_PAGE_WINDOW_SIZE)
                  )
                }
              >
                이전 {PDF_PAGE_WINDOW_SIZE}페이지
              </button>
              <span>
                {pdfPageWindow(inspection.pageCount, pageWindowStart).start + 1}
                –{pdfPageWindow(inspection.pageCount, pageWindowStart).end}
                {' / '}
                {inspection.pageCount}페이지
              </span>
              <button
                type="button"
                disabled={
                  pdfPageWindow(inspection.pageCount, pageWindowStart).end >=
                  inspection.pageCount
                }
                onClick={() =>
                  setPageWindowStart(
                    (current) => current + PDF_PAGE_WINDOW_SIZE
                  )
                }
              >
                다음 {PDF_PAGE_WINDOW_SIZE}페이지
              </button>
            </nav>
          )}
          {thumbnailLoading && (
            <p className="workfolio-pdf-preview__status" role="status">
              페이지 미리보기를 불러오는 중입니다.
            </p>
          )}
          {thumbnailError && (
            <p className="workfolio-tool-error" role="alert">
              실제 페이지 미리보기를 만들지 못했습니다. ({thumbnailError})
            </p>
          )}
          <ol className="workfolio-pdf-pages">
            {inspection.pages
              .slice(
                pdfPageWindow(inspection.pageCount, pageWindowStart).start,
                pdfPageWindow(inspection.pageCount, pageWindowStart).end
              )
              .map((page) => {
                const presentation = presentPdfPage(page)
                const selected = selectedPages.includes(page.number)
                const pageButton = (
                  <>
                    <span
                      className="workfolio-pdf-page__paper"
                      style={{
                        width: presentation.paperWidth,
                        height: presentation.paperHeight
                      }}
                    >
                      {thumbnails[page.number] ? (
                        <Image
                          unoptimized
                          src={`data:image/png;base64,${thumbnails[page.number]}`}
                          alt={`${page.number}페이지 실제 미리보기`}
                          width={Math.max(
                            1,
                            Math.ceil(presentation.paperWidth)
                          )}
                          height={Math.max(
                            1,
                            Math.ceil(presentation.paperHeight)
                          )}
                        />
                      ) : (
                        <>
                          <FileText
                            aria-hidden="true"
                            size={25}
                            strokeWidth={1.5}
                          />
                          <span>PDF</span>
                        </>
                      )}
                    </span>
                    <strong>{page.number}페이지</strong>
                    <small>
                      {presentation.orientation === 'portrait'
                        ? '세로'
                        : '가로'}{' '}
                      · {presentation.widthMm} × {presentation.heightMm} mm
                    </small>
                    <small>회전 {page.rotation}°</small>
                  </>
                )
                return (
                  <li key={page.number}>
                    {pageSelectionDisabled ? (
                      <div className="workfolio-pdf-page">{pageButton}</div>
                    ) : (
                      <button
                        className="workfolio-pdf-page"
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          const current = selectedPages
                          const next = selected
                            ? current.filter((number) => number !== page.number)
                            : operation === 'reorder'
                              ? [...current, page.number]
                              : [...current, page.number].sort((a, b) => a - b)
                          setPages(next.join(','))
                        }}
                      >
                        {pageButton}
                      </button>
                    )}
                  </li>
                )
              })}
          </ol>
        </section>
      )}
    </>
  )
}
