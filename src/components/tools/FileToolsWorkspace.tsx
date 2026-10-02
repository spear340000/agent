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
  const [files, setFiles] = useState<ManagedFile[]>([])
  const [cursor, setCursor] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<unknown>(null)
  const [search, setSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const mounted = useRef(true),
    running = useRef(false),
    loadGeneration = useRef(0)
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
  const props = { connection, files, busy, disabled: !online, run }
  return (
    <section
      className="workfolio-tools"
      aria-labelledby="workfolio-tools-title"
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
        <span>
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
            if (!selected.length) return
            void run('파일 업로드', async () => {
              const saved: ManagedFile[] = []
              try {
                for (const file of selected)
                  saved.push(await uploadSourceFile(file, connection))
                return { files: saved }
              } finally {
                if (mounted.current) void loadFiles()
              }
            })
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
        {tool === 'files' && (
          <section className="workfolio-file-library">
            <label>
              파일 이름 검색
              <input
                type="search"
                maxLength={200}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <p>
              지원 업로드: DOCX, XLSX, PDF, PPTX, TXT, CSV · 파일당 최대 10 MiB
            </p>
            <ul>
              {files
                .filter((file) =>
                  file.name
                    .toLocaleLowerCase()
                    .includes(search.toLocaleLowerCase())
                )
                .map((file) => (
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
            {!files.length && !loadingFiles && online && searchQuery && (
              <p>일치하는 파일이 없습니다.</p>
            )}
            {!files.length && !loadingFiles && online && !searchQuery && (
              <p>
                아직 파일이 없습니다. 파일을 업로드하거나 Word·Excel 도구로 새
                파일을 만드세요.
              </p>
            )}
          </section>
        )}
        {tool === 'word' && <WordTools {...props} />}
        {tool === 'excel' && <SpreadsheetTools {...props} />}
        {tool === 'pdf' && <PdfTools {...props} />}
        {tool === 'browser' && (
          <BrowserTools
            {...props}
            available={Boolean(capabilities?.browserUse.available)}
          />
        )}
        {tool === 'search' && <SearchTools {...props} />}
        {tool === 'computer' && (
          <ComputerTools
            {...props}
            available={Boolean(capabilities?.computerUse.available)}
          />
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
