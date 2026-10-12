'use client'

import {
  AlertCircle,
  ArrowLeft,
  Bold,
  Check,
  Download,
  Eye,
  FileDown,
  Heading1,
  Heading2,
  List,
  LoaderCircle,
  Pencil,
  Quote,
  Save
} from 'lucide-react'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  applyDocumentCommand,
  getDocumentOutline,
  getDocumentSaveStatus,
  prepareFinalDocument
} from './documentModel'
import type {
  DocumentCommand,
  DocumentEditResult,
  DocumentHeading
} from './documentModel'
import DocumentOutline from './DocumentOutline'
import DocumentFormatPreview, {
  type DocumentFormat
} from './DocumentFormatPreview'
import MarkdownView from './MarkdownView'

export type DocumentWorkspaceProps = {
  title: string
  value: string
  hasPersistedDocument: boolean
  dirty: boolean
  saving: boolean
  canSave?: boolean
  saveError: string | null
  initialMode?: 'view' | 'edit'
  previewMode?: boolean
  onChange: (value: string) => void
  onSave: () => Promise<void>
  onExport: (format: 'md' | 'docx' | 'xlsx' | 'pdf') => void
  onFormatPreview: (format: 'xlsx' | 'pdf') => Promise<Blob>
  onPreviewModeChange?: (preview: boolean) => void
}

const toolbarActions: {
  command: DocumentCommand
  label: string
  icon: typeof Heading1
}[] = [
  { command: 'heading1', label: '제목 1', icon: Heading1 },
  { command: 'heading2', label: '제목 2', icon: Heading2 },
  { command: 'bold', label: '굵게', icon: Bold },
  { command: 'bullet', label: '글머리 기호', icon: List },
  { command: 'quote', label: '인용구', icon: Quote }
]

const saveLabels = {
  error: '저장 실패',
  saving: '저장 중',
  unsaved: '저장되지 않음',
  saved: '저장됨'
} as const

const formatLabels: Record<DocumentFormat, string> = {
  md: 'Markdown',
  docx: 'DOCX',
  xlsx: 'Excel',
  pdf: 'PDF'
}

export default function DocumentWorkspace({
  title,
  value,
  hasPersistedDocument,
  dirty,
  saving,
  canSave = true,
  saveError,
  initialMode = 'view',
  previewMode = false,
  onChange,
  onSave,
  onExport,
  onFormatPreview,
  onPreviewModeChange
}: DocumentWorkspaceProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const pendingSelection = useRef<Pick<
    DocumentEditResult,
    'selectionStart' | 'selectionEnd'
  > | null>(null)
  const [mode, setMode] = useState<'view' | 'edit'>(initialMode)
  const [highlightedHeadingLine, setHighlightedHeadingLine] = useState<
    number | null
  >(null)
  const [previewFormat, setPreviewFormat] = useState<DocumentFormat>('md')
  const [previewArtifact, setPreviewArtifact] = useState<{
    format: 'xlsx' | 'pdf'
    document: string
    blob: Blob
  } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<{
    format: 'xlsx' | 'pdf'
    document: string
    message: string
  } | null>(null)
  const [previewRevision, setPreviewRevision] = useState(0)
  const previewRequest = useRef(0)
  const onFormatPreviewRef = useRef(onFormatPreview)
  onFormatPreviewRef.current = onFormatPreview
  const finalDocument = useMemo(
    () => prepareFinalDocument(value, title),
    [title, value]
  )
  const needsFilePreview =
    previewMode && (previewFormat === 'pdf' || previewFormat === 'xlsx')
  const currentPreviewArtifact =
    previewArtifact?.format === previewFormat &&
    previewArtifact.document === finalDocument
      ? previewArtifact
      : null
  const currentPreviewError =
    previewError?.format === previewFormat &&
    previewError.document === finalDocument
      ? previewError.message
      : ''
  const currentPreviewLoading =
    needsFilePreview &&
    (previewLoading || (!currentPreviewArtifact && !currentPreviewError))
  const headings = useMemo(
    () => getDocumentOutline(previewMode ? finalDocument : value),
    [finalDocument, previewMode, value]
  )
  const saveStatus = getDocumentSaveStatus({
    dirty,
    saving,
    error: saveError
  })

  useEffect(() => {
    const selection = pendingSelection.current
    const editor = editorRef.current
    if (!selection || !editor) return
    pendingSelection.current = null
    editor.focus()
    editor.setSelectionRange(selection.selectionStart, selection.selectionEnd)
  }, [value])

  useEffect(() => {
    const request = ++previewRequest.current
    if (!previewMode || (previewFormat !== 'pdf' && previewFormat !== 'xlsx')) {
      setPreviewLoading(false)
      return
    }

    let active = true
    const format = previewFormat
    const document = finalDocument
    setPreviewArtifact(null)
    setPreviewError(null)
    setPreviewLoading(true)

    void onFormatPreviewRef
      .current(format)
      .then((blob) => {
        if (active && request === previewRequest.current)
          setPreviewArtifact({ format, document, blob })
      })
      .catch((cause: unknown) => {
        if (active && request === previewRequest.current)
          setPreviewError({
            format,
            document,
            message:
              cause instanceof Error
                ? cause.message
                : '미리보기를 불러오지 못했습니다.'
          })
      })
      .finally(() => {
        if (active && request === previewRequest.current)
          setPreviewLoading(false)
      })

    return () => {
      active = false
    }
  }, [finalDocument, previewFormat, previewMode, previewRevision])

  function applyCommand(command: DocumentCommand) {
    const editor = editorRef.current
    if (!editor) return
    const result = applyDocumentCommand(
      value,
      editor.selectionStart,
      editor.selectionEnd,
      command
    )
    if (result.value === value) {
      editor.focus()
      editor.setSelectionRange(result.selectionStart, result.selectionEnd)
      return
    }
    pendingSelection.current = {
      selectionStart: result.selectionStart,
      selectionEnd: result.selectionEnd
    }
    onChange(result.value)
  }

  function selectHeading(heading: DocumentHeading) {
    if (mode === 'view') {
      const target = document.getElementById(`md-heading-${heading.line}`)
      setHighlightedHeadingLine(heading.line)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    const editor = editorRef.current
    if (!editor) return
    const offset = Math.min(value.length, heading.start)
    editor.focus()
    editor.setSelectionRange(offset, offset)
    setHighlightedHeadingLine(null)
  }

  function selectPreviewFormat(format: DocumentFormat) {
    setPreviewFormat(format)
    setPreviewRevision((revision) => revision + 1)
  }

  return (
    <section
      className={`document-workspace ${mode === 'edit' ? 'document-workspace--editing' : ''} ${previewMode ? 'document-workspace--final-preview' : ''}`}
      aria-labelledby="document-workspace-title"
    >
      <div className="document-workspace__toolbar-row">
        <div
          className="document-workspace__formatting"
          role="toolbar"
          aria-label="문서 서식"
        >
          {!previewMode && mode === 'edit'
            ? toolbarActions.map(({ command, label, icon: Icon }) => (
                <button
                  key={command}
                  className="document-workspace__tool"
                  type="button"
                  aria-label={label}
                  title={label}
                  onClick={() => applyCommand(command)}
                >
                  <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                </button>
              ))
            : null}
        </div>
        <div className="document-workspace__actions">
          {previewMode ? (
            <button
              className="document-workspace__button document-workspace__button--quiet document-workspace__preview-back"
              type="button"
              onClick={() => onPreviewModeChange?.(false)}
            >
              <ArrowLeft aria-hidden="true" size={15} />
              <span>작업 화면</span>
            </button>
          ) : (
            <>
              <div
                className="document-workspace__mode"
                role="group"
                aria-label="문서 보기 방식"
              >
                <button
                  className="document-workspace__button document-workspace__button--quiet"
                  type="button"
                  aria-pressed={mode === 'view'}
                  onClick={() => setMode('view')}
                >
                  <Eye aria-hidden="true" size={15} />
                  <span>보기</span>
                </button>
                <button
                  className="document-workspace__button document-workspace__button--quiet"
                  type="button"
                  aria-pressed={mode === 'edit'}
                  onClick={() => {
                    setHighlightedHeadingLine(null)
                    setMode('edit')
                  }}
                >
                  <Pencil aria-hidden="true" size={15} />
                  <span>편집</span>
                </button>
              </div>
              <button
                className="document-workspace__button document-workspace__button--quiet document-workspace__preview-open"
                type="button"
                aria-label="내보내기 미리보기"
                onClick={() => {
                  setHighlightedHeadingLine(null)
                  setMode('view')
                  onPreviewModeChange?.(true)
                }}
              >
                <Eye aria-hidden="true" size={15} />
                <span>내보내기 미리보기</span>
              </button>
            </>
          )}
          <button
            className="document-workspace__button document-workspace__button--quiet"
            type="button"
            aria-pressed={previewMode ? previewFormat === 'md' : undefined}
            onClick={() =>
              previewMode ? void selectPreviewFormat('md') : onExport('md')
            }
          >
            {previewMode ? (
              <Eye aria-hidden="true" size={15} />
            ) : (
              <Download aria-hidden="true" size={15} />
            )}
            <span>Markdown</span>
          </button>
          <button
            className="document-workspace__button document-workspace__button--quiet"
            type="button"
            aria-pressed={previewMode ? previewFormat === 'docx' : undefined}
            onClick={() =>
              previewMode ? void selectPreviewFormat('docx') : onExport('docx')
            }
          >
            {previewMode ? (
              <Eye aria-hidden="true" size={15} />
            ) : (
              <FileDown aria-hidden="true" size={15} />
            )}
            <span>DOCX</span>
          </button>
          <button
            className="document-workspace__button document-workspace__button--quiet"
            type="button"
            aria-pressed={previewMode ? previewFormat === 'xlsx' : undefined}
            onClick={() =>
              previewMode ? void selectPreviewFormat('xlsx') : onExport('xlsx')
            }
          >
            {previewMode ? (
              <Eye aria-hidden="true" size={15} />
            ) : (
              <FileDown aria-hidden="true" size={15} />
            )}
            <span>Excel</span>
          </button>
          <button
            className="document-workspace__button document-workspace__button--quiet"
            type="button"
            aria-pressed={previewMode ? previewFormat === 'pdf' : undefined}
            onClick={() =>
              previewMode ? void selectPreviewFormat('pdf') : onExport('pdf')
            }
          >
            {previewMode ? (
              <Eye aria-hidden="true" size={15} />
            ) : (
              <FileDown aria-hidden="true" size={15} />
            )}
            <span>PDF</span>
          </button>
          {previewMode ? (
            <button
              className="document-workspace__button document-workspace__button--quiet"
              type="button"
              onClick={() => onExport(previewFormat)}
            >
              <Download aria-hidden="true" size={15} />
              <span>{formatLabels[previewFormat]} 다운로드</span>
            </button>
          ) : null}
          {!previewMode ? (
            <div className="document-workspace__save-group">
              {saveStatus !== 'saved' || hasPersistedDocument ? (
                <span
                  className={`document-workspace__save-status document-workspace__save-status--${saveStatus}`}
                  role="status"
                  aria-live="polite"
                >
                  {saveStatus === 'saved' ? (
                    <Check aria-hidden="true" size={14} />
                  ) : saveStatus === 'saving' ? (
                    <LoaderCircle
                      aria-hidden="true"
                      size={14}
                      className="is-spinning"
                    />
                  ) : saveStatus === 'error' ? (
                    <AlertCircle aria-hidden="true" size={14} />
                  ) : null}
                  {saveLabels[saveStatus]}
                </span>
              ) : null}
              <button
                className="document-workspace__button document-workspace__button--primary"
                type="button"
                disabled={!dirty || saving || !canSave}
                onClick={() => void onSave().catch(() => undefined)}
              >
                <Save aria-hidden="true" size={15} />
                <span>저장</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {!previewMode && saveError ? (
        <p className="document-workspace__error" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="document-workspace__body">
        <DocumentOutline headings={headings} onSelect={selectHeading} />
        <article className="document-workspace__page">
          <header className="document-workspace__page-header">
            <h1 id="document-workspace-title">{title}</h1>
          </header>
          {mode === 'view' ? (
            <div
              className="document-workspace__preview"
              aria-label="문서 미리보기"
            >
              {previewMode ? (
                <>
                  {currentPreviewLoading ? (
                    <p
                      className="document-format-preview__message"
                      role="status"
                    >
                      {formatLabels[previewFormat]} 미리보기를 준비하고
                      있습니다…
                    </p>
                  ) : currentPreviewError ? (
                    <p
                      className="document-format-preview__message"
                      role="alert"
                    >
                      {currentPreviewError}
                    </p>
                  ) : (
                    <DocumentFormatPreview
                      format={previewFormat}
                      markdown={finalDocument}
                      file={currentPreviewArtifact?.blob ?? null}
                    />
                  )}
                </>
              ) : (
                <MarkdownView
                  value={value}
                  highlightedHeadingLine={highlightedHeadingLine}
                  onContentClick={() => setHighlightedHeadingLine(null)}
                />
              )}
            </div>
          ) : (
            <>
              <label
                className="document-workspace__editor-label"
                htmlFor="workfolio-document-editor"
              >
                문서 본문
              </label>
              <textarea
                ref={editorRef}
                id="workfolio-document-editor"
                className="document-workspace__editor"
                aria-label="문서 본문"
                value={value}
                maxLength={200000}
                onChange={(event) => onChange(event.currentTarget.value)}
                onClick={() => setHighlightedHeadingLine(null)}
                spellCheck
              />
            </>
          )}
        </article>
      </div>
    </section>
  )
}
