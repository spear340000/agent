'use client'

import {
  AlertCircle,
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
  getDocumentSaveStatus
} from './documentModel'
import type {
  DocumentCommand,
  DocumentEditResult,
  DocumentHeading
} from './documentModel'
import DocumentOutline from './DocumentOutline'
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
  onChange: (value: string) => void
  onSave: () => Promise<void>
  onExport: (format: 'md' | 'docx') => void
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

export default function DocumentWorkspace({
  title,
  value,
  hasPersistedDocument,
  dirty,
  saving,
  canSave = true,
  saveError,
  initialMode = 'view',
  onChange,
  onSave,
  onExport
}: DocumentWorkspaceProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const pendingSelection = useRef<Pick<
    DocumentEditResult,
    'selectionStart' | 'selectionEnd'
  > | null>(null)
  const [mode, setMode] = useState<'view' | 'edit'>(initialMode)
  const headings = useMemo(() => getDocumentOutline(value), [value])
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
      target?.scrollIntoView({ block: 'start' })
      return
    }
    const editor = editorRef.current
    if (!editor) return
    const offset = Math.min(value.length, heading.start)
    editor.focus()
    editor.setSelectionRange(offset, offset)
  }

  return (
    <section
      className="document-workspace"
      aria-labelledby="document-workspace-title"
    >
      <div className="document-workspace__toolbar-row">
        <div
          className="document-workspace__formatting"
          role="toolbar"
          aria-label="문서 서식"
        >
          {mode === 'edit'
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
              onClick={() => setMode('edit')}
            >
              <Pencil aria-hidden="true" size={15} />
              <span>편집</span>
            </button>
          </div>
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
            className="document-workspace__button document-workspace__button--quiet"
            type="button"
            onClick={() => onExport('md')}
          >
            <Download aria-hidden="true" size={15} />
            <span>Markdown</span>
          </button>
          <button
            className="document-workspace__button document-workspace__button--quiet"
            type="button"
            onClick={() => onExport('docx')}
          >
            <FileDown aria-hidden="true" size={15} />
            <span>DOCX</span>
          </button>
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
      </div>

      {saveError ? (
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
              <MarkdownView value={value} />
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
                spellCheck
              />
            </>
          )}
        </article>
      </div>
    </section>
  )
}
