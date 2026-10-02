'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  FolderOpen,
  Menu,
  Moon,
  PanelRight,
  RefreshCw,
  Settings,
  Sun
} from 'lucide-react'
import {
  cancelTask,
  createTask,
  downloadFile,
  getTaskDetails,
  getFile,
  listTasks,
  request,
  rerunTask,
  saveTaskDocument,
  uploadSourceFile,
  watchTask
} from '@/api/workroom'
import type { BackendTask, ManagedFile } from '@/api/workroom'
import { officeApi } from '@/api/automation'
import FileToolsWorkspace from '@/components/tools/FileToolsWorkspace'
import ConnectionDialog from './ConnectionDialog'
import useBackendConnection from './useBackendConnection'
import { persistDocumentDraft, restoreDocumentDraft } from './documentDrafts'
import Composer from './Composer'
import DocumentWorkspace from './DocumentWorkspace'
import TaskContextPanel from './TaskContextPanel'
import WorkfolioSidebar from './WorkfolioSidebar'
import WorkfolioSplitLayout from './WorkfolioSplitLayout'
import SystemExplorer, { type SystemTopic } from './SystemExplorer'
import { downloadDocument } from './Documents'
import { applySavedDocument } from './documentSave'
import { getDocumentOutline, prepareFinalDocument } from './documentModel'
import { MOCK_BACKEND_ENABLED } from '@/mocks/mode'
import {
  summarizeDocumentChanges,
  toTaskSummary,
  toWorkroomTask
} from './taskAdapters'
import type { Source, Task, TaskState } from './types'
import { stageMeta } from './types'

type SaveFailure = { taskId: string; message: string }
type ExportFormat = 'md' | 'docx'
type ColorTheme = 'light' | 'dark'
const THEME_STORAGE_KEY = 'workfolio-color-theme-v1'

function taskStateLabel(state: TaskState): string {
  if (state === 'completed') return '완료'
  if (state === 'paused') return '일시정지'
  if (state === 'failed') return '실패'
  if (state === 'cancelled') return '취소됨'
  if (state === 'queued') return '대기 중'
  if (state === 'running') return '진행 중'
  return stageMeta[state].label
}

function documentStatus(task: Task): { title: string; detail: string } {
  if (task.state === 'failed') {
    return {
      title: '문서를 만들지 못했습니다',
      detail: task.error || '작업을 다시 실행하거나 요청 내용을 수정해 주세요.'
    }
  }
  if (task.state === 'cancelled') {
    return {
      title: '작업이 취소되었습니다',
      detail: '필요하면 작업 컨텍스트에서 추가 요청을 보낼 수 있습니다.'
    }
  }
  if (task.state === 'completed') {
    return {
      title: '문서 결과물이 없습니다',
      detail: '작업은 완료됐지만 백엔드에서 문서 결과물을 반환하지 않았습니다.'
    }
  }
  if (task.state === 'queued') {
    return {
      title: '작업 대기 중',
      detail: '백엔드 작업 대기열에서 시작을 기다리고 있습니다.'
    }
  }
  if (task.state === 'paused') {
    return {
      title: '작업이 일시정지되었습니다',
      detail: '백엔드에서 작업을 다시 시작할 때까지 기다려 주세요.'
    }
  }
  return {
    title: stageMeta[task.stage].label,
    detail: stageMeta[task.stage].detail
  }
}

export default function Workroom() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobileContextOpen, setMobileContextOpen] = useState(false)
  const [theme, setTheme] = useState<ColorTheme>('light')
  const [finalPreview, setFinalPreview] = useState(false)
  const {
    connection,
    ready,
    status: backendStatus,
    capabilities,
    error: connectionError,
    reconnect,
    connect
  } = useBackendConnection()
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [view, setView] = useState<'tasks' | 'tools'>('tasks')
  const [sidebarSection, setSidebarSection] = useState<'chat' | 'system'>(
    'chat'
  )
  const [systemTopic, setSystemTopic] = useState<SystemTopic>('wiki')
  const initializedServer = useRef('')
  const uploadedFiles = useRef(new WeakMap<File, ManagedFile>())
  const currentConnection = useRef(connection)
  currentConnection.current = connection
  const [loaded, setLoaded] = useState(MOCK_BACKEND_ENABLED)
  const [notice, setNotice] = useState('')
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null)
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null)

  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem(THEME_STORAGE_KEY)
      if (savedTheme === 'light' || savedTheme === 'dark') setTheme(savedTheme)
    } catch {
      // Keep light mode when browser storage is unavailable.
    }
  }, [])

  function toggleTheme() {
    const nextTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(nextTheme)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
    } catch {
      // Theme switching still works for this session when storage is unavailable.
    }
  }

  const active = tasks.find((task) => task.id === activeId)
  const activeTaskId = active?.id
  const activeTaskState = active?.state
  const documentHeading = active
    ? getDocumentOutline(active.document).find((heading) => heading.level === 1)
        ?.title
    : undefined

  useEffect(() => {
    if (!ready) return
    if (backendStatus !== 'online') {
      if (backendStatus === 'offline') setLoaded(true)
      return
    }
    let disposed = false
    let loading = false
    async function load() {
      if (loading) return
      loading = true
      try {
        const { items } = await listTasks(connection)
        if (disposed) return
        setTasks((current) => [
          ...items.map((item) => {
            const summary = toTaskSummary(item)
            const previous = current.find((task) => task.id === item.id)
            return previous
              ? previous.updatedAt > summary.updatedAt
                ? previous
                : {
                    ...previous,
                    title: summary.title,
                    state: summary.state,
                    stage: summary.stage,
                    updatedAt: summary.updatedAt,
                    error: summary.error
                  }
              : summary
          }),
          ...current.filter(
            (task) => !items.some((item) => item.id === task.id)
          )
        ])
        if (initializedServer.current !== connection.baseUrl) {
          initializedServer.current = connection.baseUrl
          try {
            const id = localStorage.getItem(
              `workfolio-active:${connection.baseUrl}`
            )
            if (items.some((item) => item.id === id)) setActiveId(id)
          } catch {
            /* Optional workspace state. */
          }
        }
      } catch (error) {
        if (!disposed)
          setNotice(
            error instanceof Error
              ? error.message
              : '작업 목록을 불러오지 못했습니다.'
          )
      } finally {
        loading = false
        if (!disposed) setLoaded(true)
      }
    }
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [connection, ready, backendStatus])

  const updateTaskDetails = useCallback(
    (
      details: Awaited<ReturnType<typeof getTaskDetails>>,
      providedSources?: Source[]
    ) => {
      if (currentConnection.current !== connection) return
      setTasks((current) => {
        const previous = current.find((task) => task.id === details.task.id)
        if (
          previous &&
          previous.updatedAt > (Date.parse(details.task.updatedAt) || 0)
        )
          return current
        const mapped = toWorkroomTask(details, {
          sources: [...(previous?.sources ?? []), ...(providedSources ?? [])],
          messages: previous?.messages ?? [],
          document: previous?.document ?? '',
          documentDirty: previous?.documentDirty ?? false,
          revisionBaseline: previous?.revisionBaseline
        })
        let restored = mapped
        if (!previous?.documentDirty) {
          try {
            restored = restoreDocumentDraft(
              mapped,
              connection.baseUrl,
              localStorage
            )
          } catch {
            /* Server document remains usable. */
          }
        }
        if (previous?.revisionBaseline && mapped.state === 'completed') {
          const pendingMessage = [...restored.messages]
            .reverse()
            .find(
              (message) =>
                message.text === previous.revisionBaseline?.request &&
                message.kind !== 'system'
            )
          restored = {
            ...restored,
            revisionBaseline: undefined,
            messages: pendingMessage
              ? restored.messages.map((message) =>
                  message.id === pendingMessage.id
                    ? {
                        ...message,
                        changeSummary: summarizeDocumentChanges(
                          previous.revisionBaseline!.document,
                          mapped.document
                        )
                      }
                    : message
                )
              : restored.messages
          }
        }
        if (!previous) return [restored, ...current]
        return current.map((task) => (task.id === mapped.id ? restored : task))
      })
    },
    [connection]
  )

  useEffect(() => {
    if (
      !activeTaskId ||
      !activeTaskState ||
      !['queued', 'running'].includes(activeTaskState)
    ) {
      return
    }
    const controller = new AbortController()
    void watchTask(
      activeTaskId,
      updateTaskDetails,
      controller.signal,
      connection
    ).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setNotice(
          error instanceof Error
            ? error.message
            : '실시간 진행 상태를 불러오지 못했습니다.'
        )
      }
    })
    return () => controller.abort()
  }, [activeTaskId, activeTaskState, updateTaskDetails, connection])

  const refreshTask = useCallback(
    async (id: string, signal?: AbortSignal) => {
      try {
        const details = await getTaskDetails(id, connection, fetch, signal)
        const metadata = await Promise.allSettled(
          details.task.sourceFileIds.map((fileId) =>
            getFile(fileId, connection)
          )
        )
        if (signal?.aborted || currentConnection.current !== connection) return
        const sources: Source[] = metadata.flatMap((result) =>
          result.status === 'fulfilled'
            ? [
                {
                  id: result.value.file.id,
                  fileId: result.value.file.id,
                  name: result.value.file.name,
                  kind: 'file' as const
                }
              ]
            : []
        )
        updateTaskDetails(details, sources)
      } catch (error) {
        if (signal?.aborted || currentConnection.current !== connection) return
        setNotice(
          error instanceof Error ? error.message : '작업을 불러오지 못했습니다.'
        )
      }
    },
    [updateTaskDetails, connection]
  )

  useEffect(() => {
    const controller = new AbortController()
    if (activeId && backendStatus === 'online')
      void refreshTask(activeId, controller.signal)
    return () => controller.abort()
  }, [activeId, activeTaskState, backendStatus, refreshTask])

  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => {
      try {
        persistDocumentDraft(active, connection.baseUrl, localStorage)
      } catch {
        if (active.documentDirty)
          setNotice(
            '브라우저에 초안을 보관하지 못했습니다. 문서를 서버에 저장해 주세요.'
          )
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [active, connection.baseUrl])

  const hasUnsavedChanges = tasks.some((task) => task.documentDirty)
  useEffect(() => {
    if (!hasUnsavedChanges) return
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [hasUnsavedChanges])

  function openTask(id: string | null) {
    if (active?.documentDirty) {
      try {
        persistDocumentDraft(active, connection.baseUrl, localStorage)
      } catch {
        setNotice('초안을 보관하지 못했습니다. 먼저 저장해 주세요.')
        return
      }
    }
    setActiveId(id)
    setFinalPreview(false)
    setView('tasks')
    try {
      if (id) localStorage.setItem(`workfolio-active:${connection.baseUrl}`, id)
      else localStorage.removeItem(`workfolio-active:${connection.baseUrl}`)
    } catch {
      /* Optional workspace state. */
    }
    setMobileSidebarOpen(false)
    setMobileContextOpen(false)
    setSaveFailure(null)
  }

  async function prepareSources(sources: Source[]) {
    if (currentConnection.current !== connection)
      throw new Error('백엔드 연결이 변경되었습니다. 다시 요청해 주세요.')
    const cache = uploadedFiles.current
    const files = sources.filter((source) => source.kind === 'file')
    const links = sources.filter((source) => source.kind === 'link')
    if (files.length > 5 || links.length > 5)
      throw new Error('파일과 링크는 각각 최대 5개까지 추가할 수 있습니다.')
    const uploaded: Source[] = []
    for (const source of files) {
      if (source.file) {
        const file =
          cache.get(source.file) ??
          (await uploadSourceFile(source.file, connection))
        cache.set(source.file, file)
        if (currentConnection.current !== connection)
          throw new Error('백엔드 연결이 변경되었습니다. 다시 요청해 주세요.')
        uploaded.push({
          id: file.id,
          fileId: file.id,
          name: file.name,
          kind: 'file',
          status: 'queued'
        })
      } else if (source.fileId) uploaded.push(source)
      else throw new Error(`${source.name}: 파일을 다시 첨부해 주세요.`)
    }
    return {
      sources: [...uploaded, ...links],
      fileIds: uploaded.flatMap((source) =>
        source.fileId ? [source.fileId] : []
      ),
      urls: links.flatMap((source) => (source.url ? [source.url] : []))
    }
  }

  async function startTask(
    request: string,
    sources: Source[],
    workflow: 'legal' | 'document' = 'legal'
  ): Promise<boolean> {
    try {
      if (!loaded || backendStatus !== 'online') {
        throw new Error(
          '백엔드가 연결되지 않았습니다. 서버 상태를 확인한 뒤 다시 시도해 주세요.'
        )
      }
      if (
        !MOCK_BACKEND_ENABLED &&
        workflow === 'legal' &&
        capabilities?.model.configured === false
      ) {
        throw new Error(
          '모델 제공자 API 키가 설정되지 않아 작업을 시작할 수 없습니다.'
        )
      }

      const prepared = await prepareSources(sources)

      const created = await createTask(
        connection,
        request,
        prepared.fileIds,
        prepared.urls,
        fetch,
        workflow
      )
      if (currentConnection.current !== connection)
        throw new Error(
          '이전 백엔드에 작업은 접수됐지만 연결이 변경되어 화면을 갱신하지 않았습니다.'
        )
      setTasks((current) => [
        { ...toTaskSummary(created.task), sources: prepared.sources },
        ...current
      ])
      openTask(created.task.id)
      setNotice(
        MOCK_BACKEND_ENABLED
          ? '목업 작업을 만들었습니다. 실제 분석은 실행되지 않습니다.'
          : '작업 요청을 백엔드에 전달했습니다.'
      )
      void refreshTask(created.task.id)
      return true
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '작업 요청에 실패했습니다.'
      )
      return false
    }
  }

  async function submitTaskRequest(
    request: string,
    kind: 'revision' | 'followup' = 'followup',
    sources: Source[] = []
  ): Promise<boolean> {
    if (!active || !request.trim()) return false
    try {
      if (active.documentDirty) {
        const { artifact } = await saveTaskDocument(
          active.id,
          active.document,
          connection
        )
        if (currentConnection.current !== connection) return false
        setTasks((current) =>
          current.map((task) =>
            task.id === active.id
              ? applySavedDocument(task, artifact, active.document)
              : task
          )
        )
      }
      const prepared = await prepareSources(sources)
      const { task: accepted } = await sendRevision(
        active.id,
        kind,
        request.trim(),
        prepared
      )
      if (currentConnection.current !== connection) return false
      setTasks((current) =>
        current.map((task) =>
          task.id === active.id
            ? {
                ...task,
                state: accepted.status,
                stage: 'planning',
                error: undefined,
                revisionBaseline: {
                  document: active.document,
                  request: request.trim()
                },
                sources: [...task.sources, ...prepared.sources]
              }
            : task
        )
      )
      void refreshTask(active.id)
      setNotice(
        kind === 'revision'
          ? '문서 수정 요청을 전달했습니다.'
          : '추가 요청을 전달했습니다.'
      )
      return true
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '요청을 전달하지 못했습니다.'
      )
      return false
    }
  }

  function sendRevision(
    id: string,
    kind: 'revision' | 'followup',
    message: string,
    prepared: { fileIds: string[]; urls: string[] }
  ) {
    return request<{ task: BackendTask }>(
      connection,
      `/api/tasks/${encodeURIComponent(id)}/revise`,
      {
        method: 'POST',
        body: JSON.stringify({
          kind,
          message,
          sourceFileIds: prepared.fileIds,
          sourceUrls: prepared.urls
        })
      }
    )
  }

  async function cancelActiveTask() {
    if (!active) return
    try {
      updateTaskDetails(await cancelTask(active.id, connection))
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '작업 취소에 실패했습니다.'
      )
    }
  }

  async function rerunActiveTask() {
    if (!active) return
    try {
      updateTaskDetails(await rerunTask(active.id, connection))
      setNotice('작업을 다시 실행했습니다.')
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '작업 재실행에 실패했습니다.'
      )
    }
  }

  async function saveActiveDocument() {
    if (
      !active ||
      active.state !== 'completed' ||
      !active.documentDirty ||
      savingTaskId
    )
      return
    const { id, document } = active
    setSavingTaskId(id)
    setSaveFailure(null)
    try {
      const { artifact } = await saveTaskDocument(id, document, connection)
      if (currentConnection.current !== connection) return
      setTasks((current) =>
        current.map((task) =>
          task.id === id ? applySavedDocument(task, artifact, document) : task
        )
      )
      setNotice(
        MOCK_BACKEND_ENABLED
          ? '문서를 이 브라우저의 목업 저장소에 저장했습니다.'
          : '문서 버전을 백엔드에 저장했습니다.'
      )
    } catch (error) {
      setSaveFailure({
        taskId: id,
        message:
          error instanceof Error ? error.message : '문서 저장에 실패했습니다.'
      })
    } finally {
      setSavingTaskId((current) => (current === id ? null : current))
    }
  }

  async function exportDocument(format: ExportFormat) {
    if (!active?.document) return
    try {
      const finalDocument = prepareFinalDocument(
        active.document,
        documentHeading || active.title
      )
      const finalTask = { ...active, document: finalDocument }
      if (format === 'docx' && !MOCK_BACKEND_ENABLED && backendStatus === 'online') {
        const { file } = await officeApi.markdown(connection, {
          outputName: active.title,
          markdown: finalDocument
        })
        await downloadFile(file.id, file.name, connection)
      } else {
        await downloadDocument(finalTask, format)
      }
      setNotice(`${format.toUpperCase()} 파일을 다운로드했습니다.`)
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '다운로드에 실패했습니다.'
      )
    }
  }

  function changeDocument(value: string) {
    if (!active) return
    setTasks((current) =>
      current.map((task) =>
        task.id === active.id
          ? {
              ...task,
              document: value,
              documentDirty: value !== (task.savedDocument ?? '')
            }
          : task
      )
    )
    setSaveFailure((current) =>
      current?.taskId === active.id ? null : current
    )
  }

  const connectionLabel = MOCK_BACKEND_ENABLED
    ? '목업 모드'
    : backendStatus === 'checking'
      ? '백엔드 확인 중'
      : backendStatus === 'online'
        ? '백엔드 연결됨'
        : '백엔드 연결 안 됨'

  return (
    <div
      className={`workfolio ${finalPreview ? 'workfolio--final-preview' : ''}`}
      data-theme={theme}
    >
      <header className="workfolio-header">
        <button
          className="workfolio-header__menu"
          type="button"
          aria-label="작업 탐색 열기"
          onClick={() => setMobileSidebarOpen(true)}
        >
          <Menu aria-hidden="true" size={19} />
        </button>
        <div className="workfolio-header__brand">Workfolio</div>
        <button
          className="workfolio-header__action"
          type="button"
          aria-label="문서 도구 열기"
          aria-pressed={view === 'tools'}
          onClick={() => {
            setSidebarSection('chat')
            setView((current) => (current === 'tools' ? 'tasks' : 'tools'))
          }}
        >
          <FolderOpen size={17} />
          <span>문서 도구</span>
        </button>
        <div
          className={`workfolio-header__connection workfolio-header__connection--${backendStatus}`}
          role="status"
        >
          <span aria-hidden="true" />
          <span>{connectionLabel}</span>
          {!MOCK_BACKEND_ENABLED &&
          backendStatus === 'online' &&
          capabilities?.model.configured === false ? (
            <span className="workfolio-header__model-warning">
              · 모델 제공자 설정 필요
              {capabilities.model.provider
                ? ` (${capabilities.model.provider})`
                : ''}
            </span>
          ) : null}
        </div>
        <button
          className="workfolio-header__theme"
          type="button"
          aria-label={theme === 'dark' ? '화이트 모드로 전환' : '다크 모드로 전환'}
          title={theme === 'dark' ? '화이트 모드로 전환' : '다크 모드로 전환'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? (
            <Sun aria-hidden="true" size={17} />
          ) : (
            <Moon aria-hidden="true" size={17} />
          )}
        </button>
        {MOCK_BACKEND_ENABLED ? (
          <span
            className="workfolio-mock-banner"
            role="status"
            title="화면 확인용 목업입니다. 실제 AI·법령 검색·웹 검색·파일 처리·브라우저/컴퓨터 제어는 실행되지 않습니다."
          >
            목업 결과
          </span>
        ) : null}
        {!MOCK_BACKEND_ENABLED && backendStatus === 'offline' && (
          <button
            className="workfolio-header__action"
            type="button"
            aria-label="백엔드 다시 연결"
            onClick={reconnect}
          >
            <RefreshCw size={16} />
          </button>
        )}
        {!MOCK_BACKEND_ENABLED ? (
          <button
            className="workfolio-header__action"
            type="button"
            aria-label="백엔드 연결 설정"
            onClick={() => setConnectionOpen(true)}
          >
            <Settings size={17} />
          </button>
        ) : null}
        {active ? (
          <button
            className="workfolio-header__context-toggle"
            type="button"
            aria-label="작업 정보 열기"
            aria-expanded={mobileContextOpen}
            onClick={() => setMobileContextOpen((open) => !open)}
          >
            <PanelRight aria-hidden="true" size={17} />
            <span>작업 정보</span>
          </button>
        ) : null}
      </header>

      <div className="workfolio-layout">
        <WorkfolioSidebar
          theme={theme}
          onThemeToggle={toggleTheme}
          tasks={tasks}
          activeTaskId={activeId}
          filter={filter}
          onFilterChange={setFilter}
          onOpenTask={openTask}
          section={sidebarSection}
          onSectionChange={(section) => {
            setSidebarSection(section)
            if (section === 'chat') setView('tasks')
          }}
          toolsActive={view === 'tools'}
          onOpenTools={() => {
            setSidebarSection('chat')
            setView('tools')
          }}
          connectionLabel={connectionLabel}
          backendStatus={backendStatus}
          showConnectionSettings={!MOCK_BACKEND_ENABLED}
          onOpenConnection={() => setConnectionOpen(true)}
          onReconnect={reconnect}
          systemTopic={systemTopic}
          onSystemTopicChange={setSystemTopic}
          mobileOpen={mobileSidebarOpen}
          onMobileOpenChange={setMobileSidebarOpen}
        />

        <main className="workfolio-main">
          {sidebarSection === 'system' ? (
            <SystemExplorer
              capabilities={capabilities}
              backendStatus={backendStatus}
              connection={connection}
              tasks={tasks}
              onRetry={reconnect}
              topic={systemTopic}
              onTopicChange={setSystemTopic}
            />
          ) : view === 'tools' ? (
            <FileToolsWorkspace
              connection={connection}
              capabilities={capabilities}
              online={backendStatus === 'online'}
              onClose={() => setView('tasks')}
            />
          ) : active ? (
            <WorkfolioSplitLayout
              contextDrawerOpen={mobileContextOpen}
              context={
                <TaskContextPanel
                  task={active}
                  mobileOpen={mobileContextOpen}
                  onMobileOpenChange={setMobileContextOpen}
                  onCancel={() => void cancelActiveTask()}
                  onRerun={() => void rerunActiveTask()}
                  onFollowup={submitTaskRequest}
                  onDraftFromAnswer={
                    active.legal
                      ? () => {
                          void submitTaskRequest(
                            '이 답변과 확인된 근거를 바탕으로 제출 가능한 법률 문서 초안을 작성해 주세요. 인용한 근거는 그대로 유지하세요.',
                            'revision'
                          )
                        }
                      : undefined
                  }
                />
              }
              workArea={
                <section
                  className="workfolio-document-column"
                  aria-label="문서 작업 공간"
                >
                  {active.document ? (
                    <DocumentWorkspace
                      title={documentHeading || active.title}
                      value={active.document}
                      hasPersistedDocument={Boolean(
                        active.artifactFileId || active.savedDocument
                      )}
                      previewMode={finalPreview}
                      dirty={Boolean(active.documentDirty)}
                      saving={savingTaskId === active.id}
                      canSave={active.state === 'completed'}
                      saveError={
                        saveFailure?.taskId === active.id
                          ? saveFailure.message
                          : null
                      }
                      onChange={changeDocument}
                      onSave={saveActiveDocument}
                      onExport={(format) => void exportDocument(format)}
                      onPreviewModeChange={setFinalPreview}
                    />
                  ) : (
                    <div
                      className={`workfolio-document-state workfolio-document-state--${active.state}`}
                      role={active.state === 'failed' ? 'alert' : 'status'}
                    >
                      <span className="workfolio-document-state__label">
                        {taskStateLabel(active.state)}
                      </span>
                      <h1>{documentStatus(active).title}</h1>
                      <p>{documentStatus(active).detail}</p>
                    </div>
                  )}
                </section>
              }
            />
          ) : (
            <section
              className="workfolio-start"
              aria-labelledby="workfolio-start-title"
            >
              <div className="workfolio-start__heading">
                <span>한국 법률 정보</span>
                <h1 id="workfolio-start-title">무엇을 물어보시겠어요?</h1>
                <p>
                  {MOCK_BACKEND_ENABLED
                    ? '요청 입력과 작업 화면을 확인할 수 있습니다. 목업 결과는 예시이며 실제 법률 답변이나 문서를 생성하지 않습니다.'
                    : '질문과 참고 자료를 보내면 로컬 법령·판례 저장소를 찾아 인용과 함께 답변하고, 필요한 경우 법률 문서 초안까지 작성합니다.'}
                </p>
              </div>
              {!loaded && !MOCK_BACKEND_ENABLED ? (
                <p className="workfolio-start__status" role="status">
                  백엔드와 작업 목록을 확인하고 있습니다.
                </p>
              ) : null}
              {loaded &&
              !MOCK_BACKEND_ENABLED &&
              backendStatus === 'offline' ? (
                <p className="workfolio-start__warning" role="alert">
                  {connectionError || '백엔드에 연결되지 않았습니다.'} 자동으로
                  다시 확인합니다.
                </p>
              ) : null}
              {loaded &&
              !MOCK_BACKEND_ENABLED &&
              capabilities?.model.configured === false ? (
                <p className="workfolio-start__warning" role="status">
                  백엔드는 연결됐지만 모델 제공자 API 키가 설정되지 않았습니다.
                </p>
              ) : null}
              {loaded &&
              !MOCK_BACKEND_ENABLED &&
              capabilities?.legalRetrieval &&
              capabilities.legalRetrieval.state === 'unavailable' ? (
                <p className="workfolio-start__warning" role="status">
                  {capabilities.legalRetrieval.message} 인용 없는 법률 답변은
                  제공하지 않습니다.
                </p>
              ) : null}
              {loaded &&
              !MOCK_BACKEND_ENABLED &&
              capabilities?.legalRetrieval &&
              capabilities.legalRetrieval.state === 'degraded' ? (
                <p className="workfolio-start__warning" role="status">
                  {capabilities.legalRetrieval.message}
                </p>
              ) : null}
              <p className="workfolio-start__privacy">
                {MOCK_BACKEND_ENABLED
                  ? '목업 모드에서는 입력을 외부로 보내지 않습니다. 첨부 자료와 검색은 화면 예시로만 처리합니다.'
                  : '질문 내용과 검색된 조문·판례 일부가 모델 제공자에게 전송됩니다. 법령 검색은 이 컴퓨터 안에서만 실행되며, 첨부한 자료는 이 작업의 근거로만 사용되고 법령 저장소에 등록되지 않습니다.'}
              </p>
              <Composer
                onSubmit={startTask}
                disabled={!loaded || backendStatus !== 'online'}
              />
            </section>
          )}
        </main>
      </div>

      {connectionOpen && (
        <ConnectionDialog
          connection={connection}
          onClose={() => setConnectionOpen(false)}
          onConnect={(next, remember) => {
            for (const task of tasks.filter((item) => item.documentDirty))
              persistDocumentDraft(task, connection.baseUrl, localStorage)
            setTasks([])
            setActiveId(null)
            setView('tasks')
            setLoaded(false)
            setSavingTaskId(null)
            setSaveFailure(null)
            setNotice('')
            uploadedFiles.current = new WeakMap()
            initializedServer.current = ''
            connect(next, remember)
          }}
        />
      )}

      {notice ? (
        <div className="workfolio-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice('')}
            aria-label="알림 닫기"
          >
            닫기
          </button>
        </div>
      ) : null}
    </div>
  )
}
