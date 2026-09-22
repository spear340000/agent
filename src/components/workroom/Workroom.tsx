'use client'
import { useEffect, useState } from 'react'
import { FileText, Menu, Plus, X } from 'lucide-react'
import Composer from './Composer'
import { DocumentPreview, Sources, downloadDocument } from './Documents'
import { makeDraft, stateNames, type Task, type Source } from './types'

const STORAGE_KEY = 'workroom-demo-v1'
const stages = ['조사', '분석', '작성']
function readTasks(): Task[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(saved)) return []
    return saved
      .filter(
        (t) =>
          t &&
          typeof t.id === 'string' &&
          typeof t.title === 'string' &&
          typeof t.request === 'string' &&
          typeof t.document === 'string' &&
          Array.isArray(t.sources) &&
          t.sources.every(
            (s: Source) =>
              s &&
              typeof s.name === 'string' &&
              (s.url === undefined || typeof s.url === 'string')
          ) &&
          Array.isArray(t.messages) &&
          t.messages.every(
            (m: Task['messages'][number]) =>
              m &&
              typeof m.text === 'string' &&
              ['revision', 'followup'].includes(m.kind) &&
              (m.scope === undefined || typeof m.scope === 'string')
          ) &&
          Number.isInteger(t.stage) &&
          t.stage >= 0 &&
          t.stage <= 2 &&
          ['running', 'paused', 'complete'].includes(t.state)
      )
      .map((t) => ({ ...t, state: t.state === 'running' ? 'paused' : t.state }))
  } catch {
    return []
  }
}
export default function Workroom() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loaded, setLoaded] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [filter, setFilter] = useState('all')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [tab, setTab] = useState('document')
  const [editing, setEditing] = useState(false)
  const [revision, setRevision] = useState('')
  const [scope, setScope] = useState('')
  const [notice, setNotice] = useState('')
  const [saveFailed, setSaveFailed] = useState(false)
  const active = tasks.find((t) => t.id === activeId)
  useEffect(() => {
    setTasks(readTasks())
    setLoaded(true)
  }, [])
  useEffect(() => {
    if (!loaded) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
      setSaveFailed(false)
    } catch {
      setSaveFailed(true)
    }
  }, [tasks, loaded])
  useEffect(() => {
    const timer = setInterval(
      () =>
        setTasks((old) =>
          !old.some((t) => t.state === 'running')
            ? old
            : old.map((t) =>
                t.state !== 'running'
                  ? t
                  : t.stage < 2
                    ? { ...t, stage: t.stage + 1 }
                    : { ...t, state: 'complete', document: makeDraft(t) }
              )
        ),
      2200
    )
    return () => clearInterval(timer)
  }, [])
  function patchTask(changes: Partial<Task>) {
    setTasks((old) =>
      old.map((t) => (t.id === activeId ? { ...t, ...changes } : t))
    )
  }
  function openTask(id: string | null) {
    setActiveId(id)
    setEditing(false)
    setTab('document')
    setRevision('')
    setScope('')
    setNotice('')
    setSidebarOpen(false)
  }
  function createTask(request: string, sources: Source[]) {
    const id = crypto.randomUUID()
    setTasks((old) => [
      {
        id,
        title: request.slice(0, 40),
        request,
        sources,
        messages: [],
        stage: 0,
        state: 'running',
        document: '',
        created: Date.now()
      },
      ...old
    ])
    openTask(id)
  }
  async function download(format: 'md' | 'docx') {
    if (!active) return
    try {
      await downloadDocument(active, format)
    } catch {
      setNotice('다운로드하지 못했습니다. 다시 시도해주세요.')
    }
  }
  const shown = tasks.filter(
    (t) =>
      filter === 'all' ||
      (filter === 'complete' ? t.state === 'complete' : t.state !== 'complete')
  )
  return (
    <div className="workroom">
      <header className="app-header">
        <div className="header-left">
          <button
            className="sidebar-toggle icon-button"
            aria-label="작업 메뉴"
            aria-expanded={sidebarOpen}
            aria-controls="sidebar"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Menu size={20} />
          </button>
          <span className="brand">Workroom</span>
        </div>
        <span className="preview-label">프론트엔드 데모</span>
      </header>
      <div
        className={`workspace ${active ? 'has-task' : ''} ${sidebarOpen ? 'sidebar-open' : ''}`}
      >
        {sidebarOpen && (
          <button
            className="sidebar-backdrop"
            aria-label="메뉴 닫기"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <aside className="sidebar" id="sidebar" aria-label="작업 관리">
          <button className="new-task" onClick={() => openTask(null)}>
            <Plus size={18} />새 작업
          </button>
          <h2>최근 작업</h2>
          {!!tasks.length && (
            <div className="filters" aria-label="작업 상태 필터">
              {[
                ['all', '전체'],
                ['running', '진행'],
                ['complete', '완료']
              ].map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="history">
            {shown.map((task) => (
              <button
                key={task.id}
                className={`history-item ${task.id === activeId ? 'selected' : ''}`}
                aria-current={task.id === activeId ? 'page' : undefined}
                onClick={() => openTask(task.id)}
              >
                <span>{task.title}</span>
                <small>{stateNames[task.state]} · 데모</small>
              </button>
            ))}
          </div>
          {!shown.length && (
            <p className="empty-history">
              {tasks.length ? (
                '해당 상태의 작업이 없어요.'
              ) : (
                <>
                  아직 진행한 작업이 없어요.
                  <br />첫 문서 작업을 시작해보세요.
                </>
              )}
            </p>
          )}
          {tasks.some((t) => t.state === 'complete') && (
            <>
              <h2>문서 목록</h2>
              <div className="history">
                {tasks
                  .filter((t) => t.state === 'complete')
                  .map((t) => (
                    <button
                      className="document-link"
                      key={t.id}
                      onClick={() => openTask(t.id)}
                    >
                      <FileText size={16} />
                      <span>{t.title}</span>
                    </button>
                  ))}
              </div>
            </>
          )}
          <p className="sidebar-note">
            자료를 모으고 정리하는 곳.
            <br />
            작업은 이 브라우저에 저장돼요.
          </p>
        </aside>
        <main>
          {!active ? (
            <section className="start">
              <h1>어떤 문서를 준비할까요?</h1>
              <Composer key="new" onSubmit={createTask} />
            </section>
          ) : (
            <section className="task" key={active.id}>
              <div className="task-heading">
                <div>
                  <p className="eyebrow">문서 작업</p>
                  <h1>{active.title}</h1>
                </div>
                <span className="state-label">{stateNames[active.state]}</span>
              </div>
              <p className="demo-note">
                진행 단계는 화면 데모입니다. 실제 조사·AI 생성은 실행하지
                않습니다.
              </p>
              <div className="message user-message">
                <span className="message-label">요청사항</span>
                <p>{active.request}</p>
              </div>
              <section className="progress-section" aria-label="작업 진행">
                <div className="section-heading">
                  <h2>작업 진행</h2>
                  <button
                    className="text-button"
                    onClick={() =>
                      patchTask({
                        state: active.state === 'running' ? 'paused' : 'running'
                      })
                    }
                    disabled={active.state === 'complete'}
                  >
                    {active.state === 'complete'
                      ? '데모 완료'
                      : active.state === 'running'
                        ? '일시정지'
                        : '데모 계속'}
                  </button>
                </div>
                <ol className="progress">
                  {stages.map((label, i) => (
                    <li
                      key={label}
                      className={
                        active.state === 'complete' || i < active.stage
                          ? 'done'
                          : i === active.stage
                            ? 'current'
                            : ''
                      }
                    >
                      <span>
                        {active.state === 'complete' || i < active.stage
                          ? '✓'
                          : i + 1}
                      </span>
                      <div>
                        <strong>{label}</strong>
                        <small>
                          {
                            [
                              '첨부 자료 목록 확인',
                              '문서 구성 정리',
                              '편집 가능한 문서 틀 준비'
                            ][i]
                          }
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="muted" role="status">
                  {active.state === 'complete'
                    ? '문서 틀이 준비됐어요. 문서 패널에서 내용을 직접 편집해보세요.'
                    : active.state === 'paused'
                      ? '멈춘 작업입니다. 데모 계속을 누르면 이어집니다.'
                      : `${stages[active.stage]} 단계 시연 중…`}
                </p>
              </section>
              <details className="materials" open>
                <summary>
                  첨부 자료 <span>{active.sources.length}</span>
                </summary>
                <Sources sources={active.sources} />
              </details>
              {active.messages.map((m, i) => (
                <div className="message follow-up" key={i}>
                  <span className="message-label">
                    {m.kind === 'revision' ? '수정 요청' : '추가 요청'} · 서버
                    연결 대기
                  </span>
                  {m.scope && <blockquote>{m.scope}</blockquote>}
                  <p>{m.text}</p>
                </div>
              ))}
              <div className="follow-up-composer">
                <Composer
                  compact
                  onSubmit={(text, sources) => {
                    patchTask({
                      messages: [
                        ...active.messages,
                        { text, kind: 'followup' }
                      ],
                      sources: [...active.sources, ...sources]
                    })
                    setNotice(
                      '추가 요청을 보관했습니다. 자동 실행은 서버 연결이 필요합니다.'
                    )
                  }}
                />
              </div>
            </section>
          )}
        </main>
        {active && (
          <aside className="document-panel" aria-label="문서와 출처">
            <div className="panel-tabs">
              <button
                aria-pressed={tab === 'document'}
                onClick={() => setTab('document')}
              >
                문서
              </button>
              <button
                aria-pressed={tab === 'sources'}
                onClick={() => setTab('sources')}
              >
                출처 <span>{active.sources.length}</span>
              </button>
            </div>
            {tab === 'sources' ? (
              <Sources sources={active.sources} />
            ) : active.state !== 'complete' ? (
              <div className="document-empty">
                <FileText size={36} strokeWidth={1.2} />
                <h2>문서를 준비하고 있어요</h2>
                <p>
                  데모가 끝나면 이곳에서
                  <br />
                  문서 틀을 확인하고 편집할 수 있어요.
                </p>
              </div>
            ) : (
              <>
                <div className="document-toolbar">
                  <span>
                    {saveFailed ? '임시 보관 중' : '브라우저에 자동 저장'}
                  </span>
                  <button
                    className="small-button"
                    aria-pressed={editing}
                    onClick={() => setEditing(!editing)}
                  >
                    {editing ? '미리보기' : '직접 편집'}
                  </button>
                </div>
                {editing ? (
                  <textarea
                    className="document-editor"
                    aria-label="문서 내용 편집"
                    value={active.document}
                    onChange={(e) => patchTask({ document: e.target.value })}
                  />
                ) : (
                  <DocumentPreview text={active.document} />
                )}
                <form
                  className="revision-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (!revision.trim()) return
                    patchTask({
                      messages: [
                        ...active.messages,
                        {
                          kind: 'revision',
                          text: revision.trim(),
                          scope: scope.trim()
                        }
                      ]
                    })
                    setRevision('')
                    setScope('')
                    setNotice(
                      '수정 요청을 보관했습니다. AI 재작성은 서버 연결 후 실행할 수 있습니다.'
                    )
                  }}
                >
                  <label htmlFor="scope">
                    수정할 부분 <span>선택</span>
                  </label>
                  <input
                    id="scope"
                    placeholder="예: 실행 방안의 첫 문단"
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                    maxLength={1000}
                  />
                  <label htmlFor="revision">수정 요청</label>
                  <textarea
                    id="revision"
                    placeholder="어떻게 바꿀지 적어주세요."
                    value={revision}
                    onChange={(e) => setRevision(e.target.value)}
                    maxLength={4000}
                  />
                  <button className="small-button" disabled={!revision.trim()}>
                    수정 요청 보관
                  </button>
                </form>
                <div className="downloads">
                  <span>다운로드</span>
                  <div>
                    <button onClick={() => download('md')}>Markdown</button>
                    <button onClick={() => download('docx')}>DOCX</button>
                    <button onClick={() => window.print()}>PDF 저장</button>
                  </div>
                </div>
              </>
            )}
          </aside>
        )}
      </div>
      {(notice || saveFailed) && (
        <div className="notice" role="status">
          <span>
            {saveFailed
              ? '브라우저에 저장하지 못했습니다. 새로고침 전에 문서를 다운로드해주세요.'
              : notice}
          </span>
          {!saveFailed && (
            <button aria-label="알림 닫기" onClick={() => setNotice('')}>
              <X size={16} />
            </button>
          )}
        </div>
      )}
      {active?.document && (
        <div className="print-document">
          <DocumentPreview text={active.document} />
        </div>
      )}
    </div>
  )
}
