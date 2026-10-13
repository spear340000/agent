'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, RefreshCw, Upload } from 'lucide-react'
import {
  downloadFile,
  uploadSourceFile,
  type Connection,
  type ManagedFile,
  type RuntimeCapabilities
} from '@/api/workroom'
import { officeApi } from '@/api/automation'
import WordTools from './WordTools'
import SpreadsheetTools from './SpreadsheetTools'
import PdfTools from './PdfTools'
import BrowserTools from './BrowserTools'
import SearchTools from './SearchTools'
import ComputerTools from './ComputerTools'
import ToolResultView from './ToolResultView'
import type { RunTool } from './ToolFields'
import { validateUploadBatch } from './uploadBatch'

type Tool =
  | 'files'
  | 'word'
  | 'excel'
  | 'pdf'
  | 'search'
  | 'browser'
  | 'computer'
const tabs: Array<[Tool, string]> = [
  ['files', '파일'],
  ['word', 'Word·문서'],
  ['excel', 'Excel'],
  ['pdf', 'PDF'],
  ['search', '검색'],
  ['browser', '브라우저'],
  ['computer', '컴퓨터']
]

export default function FileToolsWorkspace({
  connection,
  capabilities,
  online,
  onClose
}: {
  connection: Connection
  capabilities: RuntimeCapabilities | null
  online: boolean
  onClose: () => void
}) {
  const [tool, setTool] = useState<Tool>('files')
  const [mountedTools, setMountedTools] = useState<Set<Tool>>(
    () => new Set(['files'])
  )
  const [files, setFiles] = useState<ManagedFile[]>([])
  const [cursor, setCursor] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<unknown>(null)
  const [search, setSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [draggingFiles, setDraggingFiles] = useState(false)
  const mounted = useRef(true),
    running = useRef(false),
    loadGeneration = useRef(0),
    dragDepth = useRef(0)
  const upload = useRef<HTMLInputElement>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const loadFiles = useCallback(
    async (next?: string) => {
      const generation = ++loadGeneration.current
      setLoadingFiles(true)
      try {
        const page = await officeApi.listFiles(connection, next, searchQuery)
        if (!mounted.current || generation !== loadGeneration.current) return
        setFiles((current) =>
          next
            ? [
                ...current,
                ...page.items.filter(
                  (file) => !current.some((item) => item.id === file.id)
                )
              ]
            : page.items
        )
        setCursor(page.nextCursor)
      } catch (cause) {
        if (mounted.current && generation === loadGeneration.current)
          setError(
            cause instanceof Error
              ? cause.message
              : '파일 목록을 불러오지 못했습니다.'
          )
      } finally {
        if (mounted.current && generation === loadGeneration.current)
          setLoadingFiles(false)
      }
    },
    [connection, searchQuery]
  )
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    if (online) void loadFiles()
  }, [loadFiles, online])
  const run: RunTool = useCallback(
    async <T,>(
      title: string,
      operation: () => Promise<T>
    ): Promise<T | undefined> => {
      if (running.current || !online) return undefined
      running.current = true
      setBusy(true)
      setError('')
      setLabel(title)
      try {
        const next = await operation()
        if (mounted.current) {
          setResult(next)
          setLabel(`${title} 완료`)
          void loadFiles()
        }
        return next
      } catch (cause) {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : '작업 실패')
          setLabel('')
        }
        return undefined
      } finally {
        running.current = false
        if (mounted.current) setBusy(false)
      }
    },
    [loadFiles, online]
  )
  const uploadFiles = useCallback(
    (selected: File[]) => {
      if (!selected.length) return
      if (!online) {
        setError('백엔드에 연결된 뒤 파일을 업로드할 수 있습니다.')
        return
      }
      if (running.current) {
        setError('진행 중인 작업이 끝난 뒤 다시 업로드해 주세요.')
        return
      }
      try {
        validateUploadBatch(selected)
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : '파일을 확인해 주세요.'
        )
        return
      }
      void run('파일 업로드', async () => {
        const saved: ManagedFile[] = new Array(selected.length)
        let completed = 0
        try {
          if (mounted.current)
            setLabel(
              `파일 업로드 0/${selected.length}: ${selected[0]?.name ?? ''}`
            )
          for (const [index, file] of selected.entries()) {
            saved[index] = await uploadSourceFile(file, connection)
            completed += 1
            if (mounted.current)
              setLabel(
                `파일 업로드 ${completed}/${selected.length}: ${file.name}`
              )
          }
          return { files: saved }
        } finally {
          if (mounted.current) void loadFiles()
        }
      })
    },
    [connection, loadFiles, online, run]
  )
  const hasDraggedFiles = (transfer: DataTransfer) =>
    transfer.types.includes('Files') || transfer.files.length > 0
  const props = {
    connection,
    files,
    filesLoading: loadingFiles,
    busy,
    disabled: !online,
    run
  }
  const visibleFiles = files.filter((file) =>
    file.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  )
  return (
    <section
      className={`workfolio-tools${draggingFiles ? 'is-dragging' : ''}`}
      aria-labelledby="workfolio-tools-title"
      onDragEnter={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return
        event.preventDefault()
        dragDepth.current += 1
        setDraggingFiles(true)
      }}
      onDragOver={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = online && !busy ? 'copy' : 'none'
        setDraggingFiles(true)
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDraggingFiles(false)
      }}
      onDrop={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return
        event.preventDefault()
        dragDepth.current = 0
        setDraggingFiles(false)
        uploadFiles(Array.from(event.dataTransfer.files))
      }}
    >
      <header className="workfolio-tools__heading">
        <button type="button" onClick={onClose}>
          <ArrowLeft size={16} /> 문서 작업으로
        </button>
        <h1 id="workfolio-tools-title">문서 도구</h1>
        <p>파일을 업로드하고 필요한 작업을 직접 실행하세요.</p>
      </header>
      <nav className="workfolio-tools__tabs" aria-label="문서 도구 선택">
        {tabs.map(([id, name]) => (
          <button
            type="button"
            key={id}
            aria-pressed={tool === id}
            onClick={() => {
              if (!busy) {
                setTool(id)
                setMountedTools((current) => new Set(current).add(id))
                setSearch('')
                setSearchQuery('')
                setResult(null)
                setError('')
                setLabel('')
              }
            }}
            disabled={busy}
          >
            {name}
          </button>
        ))}
      </nav>
      {!online && (
        <p className="workfolio-tool-error" role="alert">
          백엔드에 연결된 뒤 도구를 사용할 수 있습니다.
        </p>
      )}
      <div className="workfolio-tools__upload">
        <button
          type="button"
          disabled={busy || !online}
          onClick={() => upload.current?.click()}
        >
          <Upload size={16} /> 파일 업로드
        </button>
        <button
          type="button"
          disabled={loadingFiles || busy || !online}
          onClick={() => {
            setError('')
            void loadFiles()
          }}
        >
          <RefreshCw size={15} /> 목록 새로고침
        </button>
        <span className="workfolio-tools__drop-hint" role="status">
          {draggingFiles
            ? online && !busy
              ? '여기에 놓으면 파일을 업로드합니다.'
              : '지금은 파일을 업로드할 수 없습니다.'
            : '파일 탐색기에서 이 화면으로 끌어놓기'}
        </span>
        <span className="workfolio-tools__count">
          {files.length}개 파일{cursor ? ' · 일부 조회' : ''}
        </span>
        <input
          ref={upload}
          hidden
          type="file"
          multiple
          accept=".docx,.xlsx,.pdf,.pptx,.txt,.csv"
          onChange={(event) => {
            const selected = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            uploadFiles(selected)
          }}
        />
      </div>
      {loadingFiles && <p role="status">파일 목록 확인 중…</p>}
      {label && <p role="status">{busy ? `${label} 처리 중…` : label}</p>}
      {error && (
        <p className="workfolio-tool-error" role="alert">
          {error}
        </p>
      )}
      <div className="workfolio-tools__content">
        {mountedTools.has('files') && (
          <div hidden={tool !== 'files'}>
            <section
              className="workfolio-file-library"
              aria-labelledby="workfolio-file-library-title"
            >
              <header className="workfolio-file-library__heading">
                <div>
                  <h2 id="workfolio-file-library-title">파일 보관함</h2>
                  <p>업로드한 문서를 찾고 내려받을 수 있습니다.</p>
                </div>
              </header>
              <div className="workfolio-file-library__filters">
                <span>한 번에 최대 5개 파일, 전체 25 MiB</span>
                <label>
                  파일 이름 검색
                  <input
                    type="search"
                    maxLength={200}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                {search.trim() && (
                  <button
                    type="button"
                    className="workfolio-file-library__clear-search"
                    onClick={() => {
                      setSearch('')
                      setSearchQuery('')
                    }}
                  >
                    검색어 지우기
                  </button>
                )}
                <span>
                  DOCX · XLSX · PDF · PPTX · TXT · CSV <i>파일당 최대 10 MiB</i>
                </span>
              </div>
              <ul>
                {visibleFiles.map((file) => (
                  <li key={file.id}>
                    <div>
                      <strong>{file.name}</strong>
                      <small>
                        {(file.bytes / 1024).toFixed(1)} KiB ·{' '}
                        {new Date(file.createdAt).toLocaleDateString('ko-KR')}
                      </small>
                    </div>
                    <button
                      type="button"
                      aria-label={`${file.name} 다운로드`}
                      onClick={() =>
                        void downloadFile(file.id, file.name, connection).catch(
                          (cause) =>
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : '다운로드 실패'
                            )
                        )
                      }
                    >
                      <Download size={16} />
                    </button>
                  </li>
                ))}
              </ul>
              {!visibleFiles.length &&
                !loadingFiles &&
                online &&
                searchQuery.length > 0 &&
                search.trim() === searchQuery && (
                  <div className="workfolio-file-library__empty">
                    <p>“{searchQuery}”에 맞는 파일이 없습니다.</p>
                  </div>
                )}
              {!visibleFiles.length &&
                !loadingFiles &&
                online &&
                !search.trim() && (
                  <div className="workfolio-file-library__empty">
                    <p>아직 업로드한 파일이 없습니다.</p>
                  </div>
                )}
            </section>
          </div>
        )}
        {mountedTools.has('word') && (
          <div hidden={tool !== 'word'}>
            <WordTools {...props} />
          </div>
        )}
        {mountedTools.has('excel') && (
          <div hidden={tool !== 'excel'}>
            <SpreadsheetTools {...props} />
          </div>
        )}
        {mountedTools.has('pdf') && (
          <div hidden={tool !== 'pdf'}>
            <PdfTools {...props} />
          </div>
        )}
        {mountedTools.has('browser') && (
          <div hidden={tool !== 'browser'}>
            <BrowserTools
              {...props}
              available={Boolean(capabilities?.browserUse.available)}
            />
          </div>
        )}
        {mountedTools.has('search') && (
          <div hidden={tool !== 'search'}>
            <SearchTools {...props} />
          </div>
        )}
        {mountedTools.has('computer') && (
          <div hidden={tool !== 'computer'}>
            <ComputerTools
              {...props}
              available={Boolean(capabilities?.computerUse.available)}
            />
          </div>
        )}
        {result != null && (
          <ToolResultView
            result={result}
            connection={connection}
            onError={setError}
          />
        )}
      </div>
      {cursor && (
        <button
          type="button"
          className="workfolio-tools__load-more"
          disabled={loadingFiles || busy}
          onClick={() => void loadFiles(cursor)}
        >
          파일 더 불러오기
        </button>
      )}
    </section>
  )
}
