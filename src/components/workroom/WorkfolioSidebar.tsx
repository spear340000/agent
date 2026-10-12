'use client'

import React, { useEffect, useRef, useState } from 'react'
import {
  Check,
  BookOpen,
  Boxes,
  FolderOpen,
  GitBranch,
  FileText,
  List,
  LoaderCircle,
  MessageSquare,
  Workflow,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Plus,
  Route,
  RefreshCw,
  Settings,
  Sun,
  X
} from 'lucide-react'
import type { Task, TaskState } from './types'

export type WorkfolioSidebarProps = {
  theme?: 'light' | 'dark'
  onThemeToggle?: () => void
  tasks: Task[]
  activeTaskId: string | null
  filter: 'all' | 'active' | 'completed'
  onFilterChange: (filter: 'all' | 'active' | 'completed') => void
  onOpenTask: (id: string | null) => void
  section: 'chat' | 'system'
  onSectionChange: (section: 'chat' | 'system') => void
  toolsActive: boolean
  onOpenTools: () => void
  connectionLabel: string
  backendStatus: 'checking' | 'online' | 'offline'
  onOpenConnection: () => void
  onReconnect: () => void
  systemTopic:
    | 'overview'
    | 'flow'
    | 'site-flow'
    | 'rag'
    | 'wiki'
    | 'ontology'
    | 'okf'
    | 'mcp'
  onSystemTopicChange: (topic: WorkfolioSidebarProps['systemTopic']) => void
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
}

const SIDEBAR_WIDTH_KEY = 'workfolio-sidebar-width-v1'
const SIDEBAR_COLLAPSED_KEY = 'workfolio-sidebar-collapsed-v1'
const DEFAULT_SIDEBAR_WIDTH = 250
const MIN_SIDEBAR_WIDTH = 210
const MAX_SIDEBAR_WIDTH = 340

function stateLabel(state: TaskState): string {
  if (state === 'completed') return '완료'
  if (state === 'paused') return '일시정지'
  if (state === 'failed') return '오류'
  if (state === 'cancelled') return '취소됨'
  if (state === 'queued') return '대기 중'
  if (state === 'running') return '진행 중'
  return '진행 중'
}

export default function WorkfolioSidebar({
  theme = 'light',
  onThemeToggle,
  tasks,
  activeTaskId,
  filter,
  onFilterChange,
  onOpenTask,
  section,
  onSectionChange,
  toolsActive,
  onOpenTools,
  connectionLabel,
  backendStatus,
  onOpenConnection,
  onReconnect,
  systemTopic,
  onSystemTopicChange,
  mobileOpen,
  onMobileOpenChange
}: WorkfolioSidebarProps) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [resizing, setResizing] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [collapsePreferenceLoaded, setCollapsePreferenceLoaded] =
    useState(false)
  const dragStart = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
      if (Number.isFinite(saved) && saved > 0) {
        setSidebarWidth(
          Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, saved))
        )
      }
    } catch {
      // Keep the default width when browser storage is unavailable.
    }
  }, [])

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true')
    } catch {
      // Keep the expanded navigation when browser storage is unavailable.
    } finally {
      setCollapsePreferenceLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!collapsePreferenceLoaded) return
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
    } catch {
      // Collapsing still works for this session when browser storage is unavailable.
    }
  }, [collapsed, collapsePreferenceLoaded])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    } catch {
      // Resizing still works for this session when browser storage is unavailable.
    }
  }, [sidebarWidth])

  useEffect(() => {
    if (!resizing) return
    const stopResizing = (): void => setResizing(false)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)
    return () => {
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
    }
  }, [resizing])

  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const visibleTasks = tasks.filter(
    (task) =>
      (filter === 'all' ||
        (filter === 'completed'
          ? task.state === 'completed'
          : !['completed', 'cancelled', 'failed'].includes(task.state))) &&
      (needle === '' || task.title.toLowerCase().includes(needle))
  )

  function openTask(id: string | null) {
    onSectionChange('chat')
    onOpenTask(id)
    onMobileOpenChange(false)
  }

  function resizeTo(width: number) {
    setSidebarWidth(
      Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
    )
  }

  return (
    <>
      {mobileOpen ? (
        <button
          className="workfolio-sidebar__backdrop"
          type="button"
          aria-label="탐색 메뉴 닫기"
          onClick={() => onMobileOpenChange(false)}
        />
      ) : null}
      <aside
        className={`workfolio-sidebar ${mobileOpen ? 'workfolio-sidebar--open' : ''} ${resizing ? 'workfolio-sidebar--resizing' : ''} ${collapsed ? 'workfolio-sidebar--collapsed' : ''}`}
        style={{ width: `${collapsed ? 68 : sidebarWidth}px` }}
        aria-label="작업 탐색"
      >
        <div className="workfolio-sidebar__brand-row">
          <div className="workfolio-sidebar__brand-mark" aria-hidden="true">
            W
          </div>
          <span className="workfolio-sidebar__brand">Workfolio</span>
          <button
            className="workfolio-sidebar__collapse"
            type="button"
            aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
            title={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" size={16} />
            ) : (
              <PanelLeftClose aria-hidden="true" size={16} />
            )}
          </button>
          <button
            className="workfolio-sidebar__close"
            type="button"
            aria-label="탐색 메뉴 닫기"
            onClick={() => onMobileOpenChange(false)}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </div>

        {section === 'chat' ? (
          <button
            className="workfolio-sidebar__new"
            type="button"
            aria-label="새 작업"
            title="새 작업"
            onClick={() => openTask(null)}
          >
            <Plus aria-hidden="true" size={17} />
            <span className="workfolio-sidebar__new-label">새 작업</span>
          </button>
        ) : null}

        <nav className="workfolio-sidebar__sections" aria-label="주 메뉴">
          <button
            type="button"
            aria-current={
              section === 'chat' && !toolsActive ? 'page' : undefined
            }
            title="채팅"
            onClick={() => onSectionChange('chat')}
          >
            <MessageSquare aria-hidden="true" size={17} />
            <span>채팅</span>
          </button>
          <button
            type="button"
            aria-current={
              section === 'system' && !toolsActive ? 'page' : undefined
            }
            title="시스템 구성"
            onClick={() => onSectionChange('system')}
          >
            <Boxes aria-hidden="true" size={17} />
            <span>시스템 구성</span>
          </button>
          <button
            className="workfolio-sidebar__tools"
            type="button"
            aria-current={toolsActive ? 'page' : undefined}
            title="문서 도구"
            onClick={onOpenTools}
          >
            <FolderOpen aria-hidden="true" size={17} />
            <span>문서 도구</span>
          </button>
        </nav>

        {section === 'chat' ? (
          <>
            <div className="workfolio-sidebar__section-heading">채팅 내역</div>
            <nav className="workfolio-sidebar__filters" aria-label="채팅 필터">
              {(
                [
                  ['all', '전체', List],
                  ['active', '진행 중', LoaderCircle],
                  ['completed', '완료', Check]
                ] as const
              ).map(([value, label, Icon]) => {
                const count = tasks.filter(
                  (task) =>
                    value === 'all' ||
                    (value === 'completed'
                      ? task.state === 'completed'
                      : !['completed', 'cancelled', 'failed'].includes(
                          task.state
                        ))
                ).length
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    aria-label={label}
                    title={label}
                    onClick={() => onFilterChange(value)}
                  >
                    <Icon aria-hidden="true" size={14} />
                    <span className="workfolio-sidebar__filter-label">
                      {label}
                    </span>
                    <span className="workfolio-sidebar__count">{count}</span>
                  </button>
                )
              })}
            </nav>

            {tasks.length > 8 ? (
              <input
                className="workfolio-sidebar__search"
                type="search"
                value={search}
                placeholder="채팅 검색"
                aria-label="채팅 검색"
                onChange={(event) => setSearch(event.target.value)}
              />
            ) : null}

            <div className="workfolio-sidebar__history">
              {visibleTasks.map((task) => (
                <button
                  className={`workfolio-sidebar__task ${!toolsActive && task.id === activeTaskId ? 'is-active' : ''}`}
                  key={task.id}
                  type="button"
                  aria-current={
                    !toolsActive && task.id === activeTaskId
                      ? 'page'
                      : undefined
                  }
                  aria-label={`${task.title} · ${stateLabel(task.state)}`}
                  title={`${task.title} · ${stateLabel(task.state)}`}
                  onClick={() => openTask(task.id)}
                >
                  <FileText aria-hidden="true" size={16} />
                  <span className="workfolio-sidebar__task-copy">
                    <strong>{task.title}</strong>
                    <small>{stateLabel(task.state)}</small>
                  </span>
                </button>
              ))}
              {visibleTasks.length === 0 ? (
                <p className="workfolio-sidebar__empty">
                  {tasks.length === 0
                    ? '아직 작업이 없습니다.'
                    : '조건에 맞는 작업이 없습니다.'}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div
            className="workfolio-sidebar__system-links"
            aria-label="시스템 문서"
          >
            <div className="workfolio-sidebar__section-heading">구성 요소</div>
            {(
              [
                ['flow', '에이전틱 플로우', GitBranch],
                ['site-flow', '사이트 동작 흐름', Route],
                ['rag', 'RAG 검색', List],
                ['wiki', 'LLM Wiki', BookOpen],
                ['ontology', '온톨로지·그래프', Boxes],
                ['okf', 'OKF 메타데이터', FileText],
                ['mcp', 'MCP·도구', Workflow]
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                title={label}
                aria-current={systemTopic === id ? 'page' : undefined}
                onClick={() => onSystemTopicChange(id)}
              >
                <Icon aria-hidden="true" size={16} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}

        <div className="workfolio-sidebar__utility">
          <div
            className={`workfolio-sidebar__connection workfolio-sidebar__connection--${backendStatus}`}
            role="status"
            title={connectionLabel}
          >
            <span aria-hidden="true" />
            <span>{connectionLabel}</span>
          </div>
          {!onThemeToggle && backendStatus !== 'offline' ? null : (
            <div className="workfolio-sidebar__utility-actions">
              {onThemeToggle ? (
                <button
                  type="button"
                  aria-label={
                    theme === 'dark' ? '화이트 모드로 전환' : '다크 모드로 전환'
                  }
                  title={
                    theme === 'dark' ? '화이트 모드로 전환' : '다크 모드로 전환'
                  }
                  onClick={onThemeToggle}
                >
                  {theme === 'dark' ? (
                    <Sun aria-hidden="true" size={16} />
                  ) : (
                    <Moon aria-hidden="true" size={16} />
                  )}
                </button>
              ) : null}
              {backendStatus === 'offline' ? (
                <button
                  type="button"
                  aria-label="백엔드 다시 연결"
                  title="백엔드 다시 연결"
                  onClick={onReconnect}
                >
                  <RefreshCw aria-hidden="true" size={16} />
                </button>
              ) : null}
              <button
                type="button"
                aria-label="백엔드 연결 설정"
                title="백엔드 연결 설정"
                onClick={onOpenConnection}
              >
                <Settings aria-hidden="true" size={16} />
              </button>
            </div>
          )}
        </div>

        <div
          className="workfolio-sidebar__resizer"
          role="separator"
          aria-label="탐색 너비 조절"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          onKeyDown={(event) => {
            const amount = event.shiftKey ? 25 : 10
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              resizeTo(sidebarWidth - amount)
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              resizeTo(sidebarWidth + amount)
            } else if (event.key === 'Home') {
              event.preventDefault()
              resizeTo(MIN_SIDEBAR_WIDTH)
            } else if (event.key === 'End') {
              event.preventDefault()
              resizeTo(MAX_SIDEBAR_WIDTH)
            }
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            dragStart.current = { x: event.clientX, width: sidebarWidth }
            setResizing(true)
          }}
          onPointerMove={(event) => {
            const start = dragStart.current
            if (
              start &&
              event.currentTarget.hasPointerCapture(event.pointerId)
            ) {
              resizeTo(start.width + event.clientX - start.x)
            }
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            dragStart.current = null
            setResizing(false)
          }}
          onPointerCancel={() => {
            dragStart.current = null
            setResizing(false)
          }}
        />
      </aside>
    </>
  )
}
