'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowRight,
  BookOpen,
  Boxes,
  Braces,
  CircleHelp,
  Database,
  GitBranch,
  Network,
  Search,
  Server,
  Workflow
} from 'lucide-react'
import {
  getLegalCatalog,
  getLegalPrecedent,
  getLegalWikiPage,
  listLegalTools,
  listLegalWikiPages,
  searchLegalLibrary,
  type Connection,
  type LegalCatalogEntry,
  type LegalLibraryItem,
  type LegalMcpTool,
  type LegalWikiPageChunk,
  type LegalWikiPageSummary,
  type RuntimeCapabilities
} from '@/api/workroom'
import EvidenceChain from './EvidenceChain'
import MarkdownView from './MarkdownView'
import { safeHttpUrl } from './safe-http-url'
import { legalIntentLabels, stageMeta, type Task } from './types'

type Props = {
  capabilities: RuntimeCapabilities | null
  backendStatus: 'checking' | 'online' | 'offline'
  onRetry: () => void
  connection: Connection
  tasks: Task[]
  topic: SystemTopic
  onTopicChange: (topic: SystemTopic) => void
}

export type SystemTopic =
  | 'overview'
  | 'flow'
  | 'rag'
  | 'wiki'
  | 'ontology'
  | 'okf'
  | 'mcp'

const topics: { id: SystemTopic; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: '개요', icon: Boxes },
  { id: 'flow', label: '에이전틱 플로우', icon: GitBranch },
  { id: 'rag', label: 'RAG 검색', icon: Search },
  { id: 'wiki', label: 'LLM Wiki', icon: BookOpen },
  { id: 'ontology', label: '온톨로지·그래프', icon: Network },
  { id: 'okf', label: 'OKF 메타데이터', icon: Braces },
  { id: 'mcp', label: 'MCP·도구', icon: Workflow }
]

function Status({ ready, label }: { ready: boolean | null; label: string }) {
  const value = ready === null ? '확인 불가' : ready ? '준비됨' : '비활성'
  return (
    <span
      className={`system-explorer__status system-explorer__status--${ready === null ? 'unknown' : ready ? 'ready' : 'off'}`}
    >
      {label} · {value}
    </span>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function excerptText(value: string): string {
  return value
    .replace(/^\s*법률명:\s*/u, '')
    .replace(/#{1,6}\s*/gu, '')
    .replace(/\*\*(.*?)\*\*/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

function parseWikiDocument(content: string): {
  body: string
  metadata: Array<{ label: string; value: string }>
} {
  const lines = content.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  if (lines[0] !== '---') return { body: content, metadata: [] }
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---'
  )
  if (end < 0) return { body: content, metadata: [] }

  const labels: Record<string, string> = {
    type: '자료 유형',
    title: '원문 제목',
    sources: '출처 파일',
    status: '상태'
  }
  const fields: Array<{
    key: string
    label: string
    value: string
    items: number
  }> = []
  for (const line of lines.slice(1, end)) {
    const field = line.match(/^([\w-]+):\s*(.*)$/u)
    if (field) {
      fields.push({
        key: field[1],
        label: labels[field[1]] ?? field[1],
        value: field[2].trim(),
        items: 0
      })
    } else if (line.trim() && fields.length) {
      const last = fields[fields.length - 1]
      if (last.key === 'sources' && /^\s*-\s+/u.test(line)) last.items += 1
      else last.value = [last.value, line.trim()].filter(Boolean).join(' ')
    }
  }
  const cleanValue = (value: string) => {
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        return JSON.parse(value) as string
      } catch {
        return value.slice(1, -1)
      }
    }
    return value.replace(/^'(.*)'$/u, '$1')
  }
  return {
    body: lines
      .slice(end + 1)
      .join('\n')
      .trimStart(),
    metadata: fields
      .map((field) => ({
        label: field.label,
        value:
          field.key === 'sources'
            ? `${field.items || (field.value && field.value !== '[]' ? 1 : 0)}개`
            : field.key === 'type' && field.value === 'Document'
              ? '문서'
              : field.key === 'status' && field.value === 'active'
                ? '사용 중'
                : cleanValue(field.value)
      }))
      .filter((field) => field.value)
  }
}

const GRAPH_RELATION_LABELS: Record<string, string> = {
  RELATES_TO: '개념 연결',
  CITES_ARTICLE: '조문 인용',
  CITES_LAW: '법률 인용',
  HAS_ARTICLE: '조문 포함',
  DERIVED_FROM: '원문 출처',
  DECIDED_BY: '판결 법원'
}

type GraphResultGroup = {
  key: string
  category: string
  name: string
  index: number
  items: LegalLibraryItem[]
}

function groupGraphItems(items: LegalLibraryItem[]): GraphResultGroup[] {
  const groups = new Map<
    string,
    Omit<GraphResultGroup, 'index' | 'items'> & { items: LegalLibraryItem[] }
  >()

  for (const item of items) {
    const edge = item.graphRelation
    const nodes = edge
      ? [
          { id: edge.sourceId, label: edge.sourceLabel, type: edge.sourceType },
          { id: edge.targetId, label: edge.targetLabel, type: edge.targetType }
        ]
      : []
    const law = nodes.find((node) => /^(law)$/iu.test(node.type))
    const article = nodes.find((node) => /^(article)$/iu.test(node.type))
    const concept = nodes.find((node) => /concept/iu.test(node.type))
    const precedent = nodes.find((node) => /precedent|case/iu.test(node.type))
    const court = nodes.find((node) => /court/iu.test(node.type))
    const document = nodes.find((node) => /document|source/iu.test(node.type))
    const node = law ?? article ?? concept ?? precedent ?? court ?? document

    let category = '관계'
    let name = edge
      ? (GRAPH_RELATION_LABELS[edge.relation] ?? edge.relation)
      : item.title

    if (node) {
      if (node === law) category = '법률'
      else if (node === article) {
        category = /^헌법/u.test(node.label)
          ? '헌법'
          : /규칙/u.test(node.label)
            ? '규칙'
            : '법률'
      } else if (node === concept) category = '개념'
      else if (node === precedent) category = '판례'
      else if (node === court) category = '법원'
      else if (node === document) category = '출처'

      name =
        category === '법률' ? node.label.replace(/^법률\s*/u, '') : node.label
    }

    const key = `${category}:${name.trim().toLocaleLowerCase()}`
    const existing = groups.get(key)
    if (existing) existing.items.push(item)
    else groups.set(key, { key, category, name, items: [item] })
  }

  const categoryIndexes = new Map<string, number>()
  return [...groups.values()].map((group) => {
    const index = (categoryIndexes.get(group.category) ?? 0) + 1
    categoryIndexes.set(group.category, index)
    return { ...group, index }
  })
}

function LegalGraphCanvas({
  items,
  onSelectNode,
  includeContext
}: {
  items: LegalLibraryItem[]
  onSelectNode: (label: string) => void
  includeContext: boolean
}) {
  const edges = items
    .flatMap((item) => (item.graphRelation ? [item.graphRelation] : []))
    .filter(
      (edge) =>
        includeContext ||
        !['DERIVED_FROM', 'DECIDED_BY'].includes(edge.relation)
    )
  if (!edges.length) return null

  const sources = [
    ...new Map(
      edges.map((edge) => [
        edge.sourceId,
        { id: edge.sourceId, label: edge.sourceLabel, type: edge.sourceType }
      ])
    ).values()
  ]
  const targets = [
    ...new Map(
      edges.map((edge) => [
        edge.targetId,
        { id: edge.targetId, label: edge.targetLabel, type: edge.targetType }
      ])
    ).values()
  ]
  const nodes = [
    ...new Map([...sources, ...targets].map((node) => [node.id, node])).values()
  ]
  const nodeKey = (node: (typeof nodes)[number]) =>
    `${node.type}:${node.label.trim().toLocaleLowerCase()}`
  const duplicateTotals = new Map<string, number>()
  for (const node of nodes)
    duplicateTotals.set(
      nodeKey(node),
      (duplicateTotals.get(nodeKey(node)) ?? 0) + 1
    )
  const duplicatePositions = new Map<string, number>()
  const rowHeight = 100
  const height = Math.max(300, edges.length * rowHeight + 70)
  const nodeLabel = (label: string) =>
    [...label].length > 34 ? `${[...label].slice(0, 33).join('')}…` : label
  const nodeColor = (type: string) =>
    type === 'LegalConcept'
      ? '#e4eee6'
      : type === 'Precedent'
        ? '#e8ece5'
        : type === 'Article'
          ? '#f2ecdc'
          : '#edeae2'

  return (
    <section
      className="system-explorer__graph-panel"
      aria-labelledby="legal-graph-title"
    >
      <div className="system-explorer__graph-heading">
        <div>
          <h3 id="legal-graph-title">실제 관계 경로</h3>
          <p>
            검색어와 일치한 그래프 노드에서 읽기 전용으로 확인한 관계입니다.
          </p>
        </div>
        <span>
          {edges.length}개 관계 · {nodes.length}개 노드
        </span>
      </div>
      <div className="system-explorer__graph-scroll">
        <svg
          className="system-explorer__graph-svg"
          viewBox={`0 0 1000 ${height}`}
          role="img"
          aria-labelledby="legal-graph-title"
        >
          <defs>
            <marker
              id="legal-graph-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="#789183" />
            </marker>
          </defs>
          {edges.map((edge, index) => {
            const y = 42 + index * rowHeight
            const source = {
              id: edge.sourceId,
              label: edge.sourceLabel,
              type: edge.sourceType
            }
            const target = {
              id: edge.targetId,
              label: edge.targetLabel,
              type: edge.targetType
            }
            return (
              <g key={`${edge.sourceId}:${edge.relation}:${edge.targetId}`}>
                <title>
                  {source.label} —{edge.relation}→ {target.label}
                </title>
                <path
                  d={`M 322 ${y + 34} C 440 ${y + 34}, 560 ${y + 34}, 678 ${y + 34}`}
                  fill="none"
                  stroke="#91a397"
                  strokeWidth="1.5"
                  markerEnd="url(#legal-graph-arrow)"
                />
                <text
                  x="500"
                  y={y + 28}
                  textAnchor="middle"
                  className="system-explorer__graph-edge-label"
                >
                  {GRAPH_RELATION_LABELS[edge.relation] ?? edge.relation}
                </text>
                <g>
                  <title>
                    {source.label} · {source.type} · {source.id}
                  </title>
                  <rect
                    x="28"
                    y={y}
                    width="294"
                    height="68"
                    rx="5"
                    fill={nodeColor(source.type)}
                    stroke="#cbd5cc"
                  />
                  <text
                    x="46"
                    y={y + 27}
                    className="system-explorer__graph-node-label"
                  >
                    {nodeLabel(source.label)}
                  </text>
                  <text
                    x="46"
                    y={y + 49}
                    className="system-explorer__graph-node-type"
                  >
                    {source.type}
                  </text>
                </g>
                <g>
                  <title>
                    {target.label} · {target.type} · {target.id}
                  </title>
                  <rect
                    x="678"
                    y={y}
                    width="294"
                    height="68"
                    rx="5"
                    fill={nodeColor(target.type)}
                    stroke="#cbd5cc"
                  />
                  <text
                    x="696"
                    y={y + 27}
                    className="system-explorer__graph-node-label"
                  >
                    {nodeLabel(target.label)}
                  </text>
                  <text
                    x="696"
                    y={y + 49}
                    className="system-explorer__graph-node-type"
                  >
                    {target.type}
                  </text>
                </g>
              </g>
            )
          })}
        </svg>
      </div>
      <ul
        className="system-explorer__graph-node-actions"
        aria-label="관계 그래프 노드"
      >
        {nodes.map((node) => {
          const key = nodeKey(node)
          const total = duplicateTotals.get(key) ?? 1
          const position = (duplicatePositions.get(key) ?? 0) + 1
          duplicatePositions.set(key, position)
          const shortId =
            node.id.length > 20
              ? `${node.id.slice(0, 10)}…${node.id.slice(-7)}`
              : node.id
          return (
            <li key={node.id}>
              <button
                type="button"
                title={`${node.label} · ${node.type} · ${node.id}`}
                onClick={() => onSelectNode(node.label)}
              >
                {node.label}
                <small>
                  {node.type}
                  {total > 1 ? ` ${position}/${total} · ID ${shortId}` : ''}
                  {' · 노드 검색어로 사용'}
                </small>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function FlowNode({
  title,
  detail,
  meta,
  status,
  kind = 'step',
  listItem = true
}: {
  title: string
  detail: string
  meta?: string
  status: string
  kind?: 'start' | 'planner' | 'tool' | 'step' | 'result'
  listItem?: boolean
}) {
  return (
    <article
      className={`system-flow__node system-flow__node--${kind} system-flow__node--${status}`}
      role={listItem ? 'listitem' : undefined}
    >
      <span className="system-flow__node-kind">
        {kind === 'start'
          ? '사용자 요청'
          : kind === 'planner'
            ? '플래너'
            : kind === 'tool'
              ? '검색 도구'
              : kind === 'result'
                ? '결과'
                : '실행 단계'}
      </span>
      <strong>{title}</strong>
      <small>{detail}</small>
      {meta ? <span className="system-flow__node-meta">{meta}</span> : null}
    </article>
  )
}

function stepState(step: Task['steps'][number]): string {
  return step.status === 'completed'
    ? 'complete'
    : step.status === 'running'
      ? 'active'
      : step.status === 'failed'
        ? 'failed'
        : step.status === 'cancelled'
          ? 'cancelled'
          : 'waiting'
}

function stepDetail(step: Task['steps'][number]): string {
  if (step.error) return step.error
  if (step.status === 'completed') return `완료 · ${step.progress}%`
  if (step.status === 'running') return `진행 중 · ${step.progress}%`
  if (step.status === 'failed') return '실패'
  if (step.status === 'cancelled') return '취소됨'
  return '대기 중'
}

function WorkflowCanvas({ task }: { task: Task }) {
  const tools = task.legal?.sourceStatus.ledger?.tools ?? []
  const planningSteps = task.steps.filter((step) =>
    /plan|계획|요청 정리/iu.test(step.title)
  )
  const collectionSteps = task.steps.filter(
    (step) =>
      /collect|수집|검색|자료 확인|첨부.*확인/iu.test(step.title) &&
      !planningSteps.includes(step)
  )
  const otherSteps = task.steps.filter(
    (step) => !planningSteps.includes(step) && !collectionSteps.includes(step)
  )
  const citations = task.legal?.citations ?? []
  const taskLabel =
    task.state === 'completed'
      ? '완료'
      : task.state === 'failed'
        ? '실패'
        : task.state === 'cancelled'
          ? '취소됨'
          : task.state === 'paused'
            ? '일시정지'
            : task.state === 'queued'
              ? '대기 중'
              : stageMeta[task.stage].label
  const completedSteps = task.steps.filter(
    (step) => step.status === 'completed'
  ).length
  const intent = task.legal
    ? (legalIntentLabels[task.legal.intent] ?? '법률 답변')
    : '문서 작업'
  const resultStatus =
    task.state === 'completed'
      ? 'complete'
      : task.state === 'failed' || task.state === 'cancelled'
        ? 'failed'
        : task.state === 'queued' || task.state === 'paused'
          ? 'waiting'
          : 'active'
  const flowItems: (
    | {
        key: string
        type: 'node'
        node: {
          title: string
          detail: string
          meta?: string
          status: string
          kind?: 'start' | 'planner' | 'step' | 'result'
        }
      }
    | { key: string; type: 'tools' }
  )[] = [
    {
      key: 'request',
      type: 'node',
      node: {
        kind: 'start',
        title: intent,
        detail: task.request
          .replace(/\s+/gu, ' ')
          .trim()
          .replace(/\s+(추가 요청:)/gu, '\n$1'),
        meta: `참고 자료 ${task.sources.length}개 (파일 ${task.sources.filter((source) => source.kind === 'file').length}, 링크 ${task.sources.filter((source) => source.kind === 'link').length})`,
        status: 'complete'
      }
    },
    ...planningSteps.map((step) => ({
      key: step.id,
      type: 'node' as const,
      node: {
        title: step.title,
        detail: stepDetail(step),
        status: stepState(step)
      }
    })),
    ...(task.legal?.plannerCalls
      ? [
          {
            key: 'planner',
            type: 'node' as const,
            node: {
              kind: 'planner' as const,
              title: '조사 계획 수립',
              detail: `복합 조사 경로 · 플래너 ${task.legal.plannerCalls}회 호출`,
              status: 'complete'
            }
          }
        ]
      : []),
    ...collectionSteps.map((step) => ({
      key: step.id,
      type: 'node' as const,
      node: {
        title: step.title,
        detail: stepDetail(step),
        status: stepState(step)
      }
    })),
    ...(tools.length ? [{ key: 'tools', type: 'tools' as const }] : []),
    ...otherSteps.map((step) => ({
      key: step.id,
      type: 'node' as const,
      node: {
        title: step.title,
        detail: stepDetail(step),
        status: stepState(step)
      }
    })),
    {
      key: 'result',
      type: 'node',
      node: {
        kind: 'result',
        title:
          citations.length > 0
            ? '근거 포함 결과'
            : task.state === 'failed'
              ? '작업 실패'
              : '결과 문서',
        detail: `${citations.length}건 인용 · ${taskLabel}`,
        status: resultStatus
      }
    }
  ]

  return (
    <div className="system-flow" aria-label="실행 워크플로 그래프">
      <div className="system-flow__summary" aria-label="실행 현황">
        <div>
          <span>현재 상태</span>
          <strong>{taskLabel}</strong>
        </div>
        <div>
          <span>실행 단계</span>
          <strong>
            {task.steps.length
              ? `${completedSteps}/${task.steps.length} 완료`
              : task.state === 'completed'
                ? '단계 기록 없음'
                : '단계 기록 대기'}
          </strong>
        </div>
        <div>
          <span>검색 도구</span>
          <strong>
            {task.legal?.sourceStatus.ledger?.toolCalls ??
              task.legal?.toolCalls ??
              tools.length}
            회
          </strong>
        </div>
        <div>
          <span>인용 근거</span>
          <strong>{citations.length}건</strong>
        </div>
      </div>
      <div className="system-flow__canvas" role="list">
        {flowItems.map((item, index) => {
          const itemNumber = index + 1
          const hasNext = index < flowItems.length - 1
          return (
            <div
              className="system-flow__item"
              key={item.key}
              role="listitem"
              data-has-next={hasNext || undefined}
              data-row-end-three={itemNumber % 3 === 0 || undefined}
              data-row-end-two={itemNumber % 2 === 0 || undefined}
            >
              {item.type === 'node' ? (
                <FlowNode {...item.node} listItem={false} />
              ) : (
                <section
                  className="system-flow__group"
                  aria-label="실제 검색 도구 호출"
                >
                  <header>
                    <strong>실제 RAG 검색</strong>
                    <small>{tools.length}회 · 호출 순서</small>
                  </header>
                  <div className="system-flow__tool-list" role="list">
                    {tools.map((tool, toolIndex) => (
                      <FlowNode
                        key={`${tool.tool}:${toolIndex}`}
                        kind="tool"
                        title={tool.label}
                        detail={`${tool.query ? `질의: ${tool.query} · ` : ''}결과 ${tool.results}건`}
                        status={tool.results > 0 ? 'complete' : 'empty'}
                      />
                    ))}
                  </div>
                </section>
              )}
              {hasNext ? (
                <ArrowRight
                  className="system-flow__connector"
                  aria-hidden="true"
                  size={18}
                  strokeWidth={2.4}
                />
              ) : null}
            </div>
          )
        })}
      </div>
      {!task.legal?.sourceStatus.ledger && task.steps.length > 0 ? (
        <p className="system-explorer__note">
          이 작업에는 검색 도구 호출 기록이 저장되지 않아 백엔드 실행 단계만
          표시합니다.
        </p>
      ) : null}
      {!task.steps.length && !tools.length ? (
        <p className="system-explorer__note">
          이 작업에는 실행 단계 기록이 없습니다. 백엔드에서 단계 기록을 받으면
          이곳에 표시합니다.
        </p>
      ) : null}
    </div>
  )
}

type LibraryTabState = {
  items: LegalLibraryItem[]
  loading: boolean
  error: string
  searchKey: string
}

const EMPTY_LIBRARY_TAB: LibraryTabState = {
  items: [],
  loading: false,
  error: '',
  searchKey: ''
}

/** How the components hand work to each other for one legal question, in order. */
const PIPELINE: { title: string; role: string }[] = [
  { title: 'RAG 검색', role: '키워드·벡터 색인에서 법령·판례 후보를 찾음' },
  { title: 'LLM Wiki', role: '핵심 조문집으로 놓친 조문을 보충' },
  { title: '에이전트', role: '질문과 무관한 후보를 걸러냄' },
  { title: '관계 그래프', role: '남은 조문을 인용한 판례를 찾음' },
  { title: '온톨로지', role: '그래프 관계가 허용된 유형인지 검증' },
  { title: 'MCP 도구', role: '조문·판례 원문을 열어 인용을 확인' },
  { title: 'OKF', role: '각 근거와 색인의 출처를 카탈로그로 연결' },
  { title: '답변 검증', role: '근거가 뒷받침하지 않는 문장을 제거' }
]

export default function SystemExplorer(props: Props) {
  return (
    <SystemExplorerSession
      key={JSON.stringify([props.connection.baseUrl, props.connection.token])}
      {...props}
    />
  )
}

function SystemExplorerSession({
  capabilities,
  backendStatus,
  onRetry,
  connection,
  tasks,
  topic,
  onTopicChange
}: Props) {
  const retrieval = capabilities?.legalRetrieval
  const [libraryQuery, setLibraryQuery] = useState('민법')
  const [libraryCorpus, setLibraryCorpus] = useState<
    'law' | 'precedent' | 'graph' | 'all'
  >('all')
  const [libraryStates, setLibraryStates] = useState<
    Record<string, LibraryTabState>
  >({})
  const [includeGraphContext, setIncludeGraphContext] = useState(false)
  const {
    items: libraryItems,
    loading: libraryLoading,
    error: libraryError,
    searchKey: librarySearchKey
  } = libraryStates[topic] ?? EMPTY_LIBRARY_TAB
  const patchLibrary = (tab: string, patch: Partial<LibraryTabState>) =>
    setLibraryStates((current) => ({
      ...current,
      [tab]: { ...(current[tab] ?? EMPTY_LIBRARY_TAB), ...patch }
    }))
  const [precedentPages, setPrecedentPages] = useState<
    Record<
      string,
      {
        excerpt: string
        offset: number
        nextOffset: number
        total?: number
        hasMore: boolean
        loading: boolean
        error?: string
      }
    >
  >({})
  const autoLoadedTopics = useRef(new Set<string>())
  const autoLoadingTopics = useRef(new Set<string>())
  const libraryRequestIds = useRef(new Map<string, number>())
  const libraryRequestSequence = useRef(0)
  const [catalogItems, setCatalogItems] = useState<LegalCatalogEntry[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [tools, setTools] = useState<LegalMcpTool[]>([])
  const [toolsError, setToolsError] = useState('')
  const [toolsLoading, setToolsLoading] = useState(false)
  const [wikiPages, setWikiPages] = useState<LegalWikiPageSummary[]>([])
  const [wikiListLoading, setWikiListLoading] = useState(false)
  const [wikiListError, setWikiListError] = useState('')
  const [wikiRetryKey, setWikiRetryKey] = useState(0)
  const [wikiFilter, setWikiFilter] = useState('')
  const [selectedWikiPage, setSelectedWikiPage] = useState('')
  const [wikiContent, setWikiContent] = useState('')
  const [wikiPageChunk, setWikiPageChunk] = useState<LegalWikiPageChunk | null>(
    null
  )
  const [wikiPageLoading, setWikiPageLoading] = useState(false)
  const [wikiPageError, setWikiPageError] = useState('')
  const wikiPageRequest = useRef(0)
  const wikiDocument = useMemo(
    () => parseWikiDocument(wikiContent),
    [wikiContent]
  )
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const healthLabel =
    backendStatus === 'online'
      ? '연결됨'
      : backendStatus === 'checking'
        ? '확인 중'
        : '연결 안 됨'

  useEffect(() => {
    if (
      !['wiki', 'rag', 'ontology'].includes(topic) ||
      backendStatus !== 'online' ||
      autoLoadedTopics.current.has(topic) ||
      autoLoadingTopics.current.has(topic)
    )
      return
    const corpus =
      topic === 'ontology'
        ? 'graph'
        : libraryCorpus === 'graph'
          ? 'law'
          : libraryCorpus
    const initialQuery = '민법'
    const searchKey = `${topic}:${corpus}:${initialQuery}`
    const tab = topic
    const requestId = ++libraryRequestSequence.current
    libraryRequestIds.current.set(tab, requestId)
    autoLoadingTopics.current.add(tab)
    patchLibrary(tab, { loading: true })
    void searchLegalLibrary(initialQuery, corpus, connection)
      .then(({ items }) => {
        if (libraryRequestIds.current.get(tab) !== requestId) return
        patchLibrary(tab, { items, error: '', searchKey })
        autoLoadedTopics.current.add(tab)
      })
      .catch(() => {
        if (libraryRequestIds.current.get(tab) !== requestId) return
        patchLibrary(tab, {
          error:
            '자료 검색을 완료하지 못했습니다. 백엔드 상태를 확인한 뒤 다시 시도해 주세요.'
        })
      })
      .finally(() => {
        if (libraryRequestIds.current.get(tab) !== requestId) return
        autoLoadingTopics.current.delete(tab)
        patchLibrary(tab, { loading: false })
      })
  }, [backendStatus, connection, libraryCorpus, topic])

  async function runLibrarySearch(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!libraryQuery.trim()) return
    const tab = topic
    const requestId = ++libraryRequestSequence.current
    libraryRequestIds.current.set(tab, requestId)
    patchLibrary(tab, { loading: true, error: '' })
    try {
      const corpus =
        topic === 'ontology'
          ? 'graph'
          : topic === 'wiki' && libraryCorpus === 'graph'
            ? 'law'
            : libraryCorpus
      const { items } = await searchLegalLibrary(
        libraryQuery,
        corpus,
        connection
      )
      if (libraryRequestIds.current.get(tab) !== requestId) return
      patchLibrary(tab, {
        items,
        searchKey: `${tab}:${corpus}:${libraryQuery}`
      })
      autoLoadedTopics.current.add(tab)
    } catch {
      if (libraryRequestIds.current.get(tab) !== requestId) return
      patchLibrary(tab, {
        items: [],
        error:
          '자료 검색을 완료하지 못했습니다. 백엔드 상태를 확인한 뒤 다시 시도해 주세요.'
      })
    } finally {
      if (libraryRequestIds.current.get(tab) === requestId) {
        autoLoadingTopics.current.delete(tab)
        patchLibrary(tab, { loading: false })
      }
    }
  }

  useEffect(() => {
    if (topic !== 'okf' || backendStatus !== 'online' || catalogItems.length)
      return
    let cancelled = false
    setCatalogLoading(true)
    void getLegalCatalog(connection)
      .then(({ items }) => {
        if (!cancelled) {
          setCatalogItems(items)
          setCatalogError('')
        }
      })
      .catch(() => {
        if (!cancelled)
          setCatalogError(
            'OKF 문서를 불러오지 못했습니다. 백엔드 상태를 확인해 주세요.'
          )
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [backendStatus, catalogItems.length, connection, topic])

  useEffect(() => {
    if (topic !== 'wiki' || backendStatus !== 'online') return
    let cancelled = false
    setWikiListLoading(true)
    setWikiListError('')
    void listLegalWikiPages(connection)
      .then(({ items }) => {
        if (!cancelled) setWikiPages(items)
      })
      .catch(() => {
        if (!cancelled)
          setWikiListError(
            'Wiki 문서 목록을 불러오지 못했습니다. 백엔드의 Wiki 기능을 확인해 주세요.'
          )
      })
      .finally(() => {
        if (!cancelled) setWikiListLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [backendStatus, connection, topic, wikiRetryKey])

  useEffect(() => {
    if (topic !== 'mcp' || backendStatus !== 'online' || tools.length) return
    let cancelled = false
    setToolsLoading(true)
    void listLegalTools(connection)
      .then(({ items }) => {
        if (!cancelled) {
          setTools(items)
          setToolsError('')
        }
      })
      .catch(() => {
        if (!cancelled)
          setToolsError(
            '도구 목록을 불러오지 못했습니다. 백엔드 상태를 확인해 주세요.'
          )
      })
      .finally(() => {
        if (!cancelled) setToolsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [backendStatus, connection, topic, tools.length])

  const latestModelUse = [...tasks]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .find((task) => task.modelUse?.finalModel)?.modelUse
  const selectedTask =
    tasks.find((task) => task.id === selectedTaskId) ??
    tasks.find((task) => task.steps.length > 0) ??
    tasks[0]
  const libraryLoaded = librarySearchKey.startsWith(`${topic}:`)
  const visibleLibraryItems = libraryLoaded ? libraryItems : []
  const visibleGraphItems = includeGraphContext
    ? visibleLibraryItems
    : visibleLibraryItems.filter(
        (item) =>
          !['DERIVED_FROM', 'DECIDED_BY'].includes(
            item.graphRelation?.relation ?? ''
          )
      )
  const loadPrecedentPage = async (item: LegalLibraryItem, offset = 0) => {
    const key = `${item.corpus}:${item.recordId}`
    setPrecedentPages((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? {
          excerpt: '',
          offset: 0,
          nextOffset: 0,
          hasMore: true
        }),
        loading: true,
        error: undefined
      }
    }))
    try {
      const identifier =
        item.caseNumber ?? item.precedentSerial ?? item.caseName ?? item.title
      const result = await getLegalPrecedent(identifier, offset, connection)
      setPrecedentPages((current) => ({
        ...current,
        [key]: {
          excerpt: offset
            ? `${current[key]?.excerpt ?? ''}${result.item.excerpt}`
            : result.item.excerpt,
          offset: result.paging.offset ?? offset,
          nextOffset: result.nextOffset,
          total: result.paging.total,
          hasMore: result.paging.hasMore ?? false,
          loading: false
        }
      }))
    } catch {
      setPrecedentPages((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? {
            excerpt: '',
            offset: 0,
            nextOffset: offset,
            hasMore: false
          }),
          loading: false,
          error: '판례 원문을 불러오지 못했습니다. 다시 시도해 주세요.'
        }
      }))
    }
  }

  const loadWikiPage = useCallback(
    async (name: string, offset = 0, append = false) => {
      const requestId = ++wikiPageRequest.current
      setSelectedWikiPage(name)
      if (!append) {
        setWikiContent('')
        setWikiPageChunk(null)
      }
      setWikiPageLoading(true)
      setWikiPageError('')
      try {
        const chunk = await getLegalWikiPage(name, offset, 12_000, connection)
        if (requestId !== wikiPageRequest.current) return
        setWikiContent((current) =>
          append ? current + chunk.content : chunk.content
        )
        setWikiPageChunk(chunk)
      } catch {
        if (requestId !== wikiPageRequest.current) return
        setWikiPageError('Wiki 원문을 불러오지 못했습니다. 다시 시도해 주세요.')
      } finally {
        if (requestId === wikiPageRequest.current) setWikiPageLoading(false)
      }
    },
    [connection]
  )

  useEffect(() => {
    if (
      topic !== 'wiki' ||
      selectedWikiPage ||
      wikiListLoading ||
      wikiPages.length === 0
    )
      return
    void loadWikiPage(wikiPages[0].name)
  }, [loadWikiPage, selectedWikiPage, topic, wikiListLoading, wikiPages])

  const materialBrowser = (
    allowed: Array<'law' | 'precedent' | 'graph' | 'all'>,
    fixedCorpus = false
  ) => {
    const graphGroups =
      topic === 'ontology' ? groupGraphItems(visibleGraphItems) : []
    const renderRecord = (item: LegalLibraryItem) => (
      <article
        className="system-explorer__record"
        key={`${item.corpus}:${item.recordId}`}
      >
        <div className="system-explorer__record-meta">
          <span>
            [{item.citationId}]{' '}
            {item.kind === 'law-article'
              ? '법령 조문'
              : item.kind === 'precedent'
                ? '판례'
                : item.kind === 'graph'
                  ? '관계 그래프'
                  : '법률 색인 문서'}
          </span>
          {item.date ? (
            <span>
              {item.date.kind === 'decision' ? '선고' : '개정'}{' '}
              {item.date.value}
            </span>
          ) : null}
        </div>
        <h3>
          {safeHttpUrl(item.officialUrl) ? (
            <a
              href={safeHttpUrl(item.officialUrl)}
              target="_blank"
              rel="noreferrer noopener"
            >
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </h3>
        {(item.kind === 'law-article' && (item.lawName || item.articleLabel)) ||
        item.caseNumber ||
        item.court ? (
          <p className="system-explorer__record-detail">
            {[
              ...(item.kind === 'law-article'
                ? [item.lawName, item.articleLabel]
                : []),
              item.caseNumber,
              item.court
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : null}
        <p className="system-explorer__record-excerpt">
          {item.excerpt
            ? excerptText(item.excerpt)
            : '검색 결과에 본문 요약이 포함되지 않았습니다.'}
        </p>
        <details className="system-explorer__record-full">
          <summary>색인 식별자·검색 근거 보기</summary>
          <dl className="system-explorer__record-fields">
            <dt>레코드 ID</dt>
            <dd>
              <code>{item.recordId}</code>
            </dd>
            {item.indexPath ? (
              <>
                <dt>색인 출처</dt>
                <dd>
                  <code>{item.indexPath}</code>
                </dd>
              </>
            ) : null}
            {item.relevance !== undefined ? (
              <>
                <dt>코퍼스 어절 일치</dt>
                <dd>
                  {Math.round(item.relevance * 100)}%
                  {item.termMatches?.length
                    ? ` · ${item.termMatches.join(', ')}`
                    : ''}
                </dd>
              </>
            ) : null}
            {item.relatedArticles?.length ? (
              <>
                <dt>참조 조문</dt>
                <dd>{item.relatedArticles.join(' · ')}</dd>
              </>
            ) : null}
            {item.statusMarkers?.length ? (
              <>
                <dt>상태 표기</dt>
                <dd>{item.statusMarkers.join(' · ')}</dd>
              </>
            ) : null}
          </dl>
        </details>
        {item.kind === 'precedent' ? (
          <details
            className="system-explorer__record-full"
            onToggle={(event) => {
              if (
                event.currentTarget.open &&
                !precedentPages[`${item.corpus}:${item.recordId}`]
              )
                void loadPrecedentPage(item)
            }}
          >
            <summary>판례 원문과 색인 메타데이터 보기</summary>
            {(() => {
              const page = precedentPages[`${item.corpus}:${item.recordId}`]
              if (!page) return <p>원문을 불러올 준비가 되었습니다.</p>
              return (
                <>
                  {page.loading ? (
                    <p role="status">판례 원문 조회 중…</p>
                  ) : null}
                  {page.error ? (
                    <p className="system-explorer__library-error" role="alert">
                      {page.error}
                    </p>
                  ) : null}
                  {page.excerpt ? <pre>{page.excerpt}</pre> : null}
                  {page.total !== undefined ? (
                    <small>
                      원문 {page.total.toLocaleString()}자 · 현재{' '}
                      {page.nextOffset.toLocaleString()}자까지
                    </small>
                  ) : null}
                  {page.hasMore ? (
                    <button
                      type="button"
                      disabled={page.loading}
                      onClick={() =>
                        void loadPrecedentPage(item, page.nextOffset)
                      }
                    >
                      {page.loading ? '불러오는 중…' : '원문 이어서 읽기'}
                    </button>
                  ) : null}
                  {page.error ? (
                    <button
                      type="button"
                      disabled={page.loading}
                      onClick={() =>
                        void loadPrecedentPage(item, page.nextOffset)
                      }
                    >
                      다시 시도
                    </button>
                  ) : null}
                </>
              )
            })()}
          </details>
        ) : null}
      </article>
    )

    return (
      <>
        <form
          className="system-explorer__library-search"
          onSubmit={(event) => void runLibrarySearch(event)}
        >
          {!fixedCorpus ? (
            <select
              aria-label="자료 종류"
              value={
                allowed.includes(libraryCorpus) ? libraryCorpus : allowed[0]
              }
              onChange={(event) =>
                setLibraryCorpus(
                  event.target.value as 'law' | 'precedent' | 'graph' | 'all'
                )
              }
            >
              {allowed.map((item) => (
                <option value={item} key={item}>
                  {item === 'law'
                    ? '법령'
                    : item === 'precedent'
                      ? '판례'
                      : item === 'all'
                        ? '법령 + 판례'
                        : '관계 그래프'}
                </option>
              ))}
            </select>
          ) : (
            <span className="system-explorer__fixed-filter">관계 그래프</span>
          )}
          <input
            aria-label="자료 검색어"
            value={libraryQuery}
            onChange={(event) => setLibraryQuery(event.target.value)}
            placeholder={
              (allowed.includes(libraryCorpus) ? libraryCorpus : allowed[0]) ===
              'precedent'
                ? '사건명 또는 사건번호'
                : '법령명, 조문 또는 관계 검색어'
            }
          />
          <button
            type="submit"
            disabled={libraryLoading || backendStatus !== 'online'}
          >
            {libraryLoading ? '검색 중…' : '자료 검색'}
          </button>
        </form>
        {fixedCorpus && topic === 'ontology' && libraryLoaded ? (
          <>
            <div className="system-explorer__graph-filter">
              <p>
                개념·조문 관계를 우선 표시합니다. 원문 출처와 판결 법원 연결은
                문맥 정보에 있습니다.
              </p>
              <button
                type="button"
                aria-pressed={includeGraphContext}
                onClick={() => setIncludeGraphContext((value) => !value)}
              >
                {includeGraphContext
                  ? '문맥 관계 숨기기'
                  : '출처·법원 관계 포함'}
              </button>
            </div>
            <LegalGraphCanvas
              items={visibleLibraryItems}
              onSelectNode={setLibraryQuery}
              includeContext={includeGraphContext}
            />
          </>
        ) : null}
        {libraryError ? (
          <p className="system-explorer__library-error" role="alert">
            {libraryError}
          </p>
        ) : null}
        {libraryLoading ? (
          <p className="system-explorer__note" role="status">
            선택한 인덱스에서 실제 자료를 찾고 있습니다.
          </p>
        ) : null}
        {!libraryLoading &&
        libraryLoaded &&
        (topic === 'ontology'
          ? visibleGraphItems.length
          : visibleLibraryItems.length) === 0 &&
        !libraryError ? (
          <p className="system-explorer__note">
            {librarySearchKey.split(':')[1] === 'graph'
              ? visibleLibraryItems.length > 0
                ? `개념·조문 관계는 찾지 못했습니다. 조회된 ${visibleLibraryItems.length}건은 모두 출처·법원 연결이라 숨겨져 있으며, '출처·법원 관계 포함'을 누르면 볼 수 있습니다.`
                : '검색 서버가 이 질의에서 검증 가능한 관계 경로를 반환하지 않았습니다. 노드 ID만으로는 관계 근거를 만들지 않습니다.'
              : '이 검색어와 일치하는 자료가 없습니다. 다른 표현으로 검색해 보세요.'}
          </p>
        ) : null}
        <div
          className={`system-explorer__records${topic === 'ontology' ? 'system-explorer__records--grouped' : ''}`}
          aria-live="polite"
        >
          {topic === 'ontology'
            ? graphGroups.map((group) => (
                <details
                  className="system-explorer__graph-category"
                  key={group.key}
                >
                  <summary>
                    <span className="system-explorer__graph-category-label">
                      {group.category} {group.index}
                    </span>
                    <strong className="system-explorer__graph-category-name">
                      {group.name}
                    </strong>
                    <span className="system-explorer__graph-category-count">
                      {group.items.length}건
                    </span>
                  </summary>
                  <div className="system-explorer__graph-category-records">
                    {group.items.map(renderRecord)}
                  </div>
                </details>
              ))
            : visibleLibraryItems.map(renderRecord)}
        </div>
        {libraryLoaded && visibleLibraryItems.length > 0 ? (
          <p className="system-explorer__note">
            {topic === 'ontology'
              ? `표시 ${visibleGraphItems.length}건 / 전체 관계 ${visibleLibraryItems.length}건`
              : `검색 결과 ${visibleLibraryItems.length}건${libraryCorpus === 'all' ? ` · 법령 ${visibleLibraryItems.filter((item) => item.corpus === 'law').length}건 · 판례 ${visibleLibraryItems.filter((item) => item.corpus === 'precedent').length}건` : ''}`}{' '}
            · 총 검색 건수는 인덱스가 제공하지 않아 표시하지 않습니다.
          </p>
        ) : null}
      </>
    )
  }

  return (
    <section
      className="system-explorer"
      aria-labelledby="system-explorer-title"
    >
      <header className="system-explorer__header">
        <div>
          <h1 id="system-explorer-title">시스템 구성</h1>
          <p>
            작업을 처리하는 에이전트와 지식 기반의 구조 및 현재 준비 상태를
            확인합니다.
          </p>
        </div>
        <Status
          ready={
            backendStatus === 'online'
              ? true
              : backendStatus === 'offline'
                ? false
                : null
          }
          label={`백엔드 ${healthLabel}`}
        />
      </header>

      <nav className="system-explorer__tabs" aria-label="시스템 구성 요소">
        {topics.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={topic === id}
            onClick={() => onTopicChange(id)}
          >
            <Icon aria-hidden="true" size={16} />
            {label}
          </button>
        ))}
      </nav>

      {topic === 'overview' ? (
        <div className="system-explorer__content">
          <div className="system-explorer__summary-grid">
            <article>
              <Server aria-hidden="true" />
              <span>사용 모델</span>
              <strong>
                {capabilities?.model.providers?.[0]
                  ? `${capabilities.model.providers[0]} · `
                  : ''}
                {capabilities?.model.name ?? '확인 필요'}
              </strong>
              <small>
                {capabilities?.model.providers?.[0]
                  ? `제공자 ${capabilities.model.providers[0]}의 기본 모델`
                  : (capabilities?.model.provider ?? '모델 제공자 확인 대기')}
                {latestModelUse?.finalModel
                  ? ` · 최근 작업 실제 응답: ${latestModelUse.finalModel}`
                  : ''}
              </small>
              <Status
                ready={capabilities?.model.configured ?? null}
                label="설정"
              />
            </article>
            <article>
              <Database aria-hidden="true" />
              <span>법률 코퍼스</span>
              <strong>
                {retrieval?.corpus.laws ?? '—'} 법령 ·{' '}
                {retrieval?.corpus.precedents ?? '—'} 판례
              </strong>
              <Status ready={retrieval?.ready ?? null} label="검색" />
            </article>
            <article>
              <Activity aria-hidden="true" />
              <span>검색 레이어</span>
              <strong>{retrieval?.state ?? '백엔드 연결 대기'}</strong>
              <small>키워드·벡터·그래프·온톨로지 상태는 RAG 탭에서 확인</small>
            </article>
          </div>
          <h2>질문 하나가 지나가는 순서</h2>
          <ol
            className="system-explorer__pipeline"
            aria-label="지식 계층 연결 순서"
          >
            {PIPELINE.map((step) => (
              <li key={step.title}>
                <strong>{step.title}</strong>
                <span>{step.role}</span>
              </li>
            ))}
          </ol>
          <h2>구성 요소</h2>
          <div className="system-explorer__cards">
            {topics.slice(1).map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" onClick={() => onTopicChange(id)}>
                <Icon aria-hidden="true" />
                <span>
                  <strong>{label}</strong>
                  <small>
                    {id === 'flow'
                      ? '실행 단계·플래너·검색 도구 호출 기록'
                      : id === 'rag'
                        ? '법령·판례 검색 계층과 실행 상태'
                        : id === 'wiki'
                          ? '법률 지식 항목과 출처 구조'
                          : id === 'ontology'
                            ? '관계 그래프와 온톨로지 상태'
                            : id === 'okf'
                              ? '출처·날짜·정규화 메타데이터 상태'
                              : 'MCP 서버와 연결 도구 현황'}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {topic === 'flow' ? (
        <div className="system-explorer__content" id="system-flow">
          <h2>에이전틱 플로우</h2>
          <p className="system-explorer__lead">
            요청부터 자료 검색, 분석, 문서 결과까지 저장된 실행 단계와 실제 도구
            호출을 한눈에 확인합니다.
          </p>
          {tasks.length ? (
            <label className="system-explorer__task-select">
              실행 기록
              <select
                aria-label="실행 작업"
                value={selectedTask?.id ?? ''}
                onChange={(event) => setSelectedTaskId(event.target.value)}
              >
                {tasks.map((task) => (
                  <option value={task.id} key={task.id}>
                    {task.title} · {task.state}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {selectedTask ? (
            <>
              <div className="system-explorer__task-summary">
                <strong>{selectedTask.title}</strong>
                <span>{selectedTask.request}</span>
                <small>
                  상태 {selectedTask.state} · 단계 {selectedTask.steps.length}개
                  · 첨부 자료 {selectedTask.sources.length}개
                  {selectedTask.legal
                    ? ` · 검색 근거 ${selectedTask.legal.sourceStatus.retrieved}건 · 본문 인용 ${selectedTask.legal.sourceStatus.cited ?? 0}건`
                    : ''}
                  {selectedTask.modelUse
                    ? ` · 응답 모델 ${selectedTask.modelUse.finalModel ?? '없음'}${selectedTask.modelUse.fellBack ? ` (대체 사용, 실패: ${selectedTask.modelUse.failedModels.join(', ')})` : ''}`
                    : ''}
                </small>
              </div>
              {selectedTask.legal ? (
                <>
                  <p className="system-explorer__note">
                    실행 경로:{' '}
                    {selectedTask.legal.path === 'orchestrated'
                      ? '플래너 계획 사용'
                      : '직접 조회'}{' '}
                    · 플래너 호출 {selectedTask.legal.plannerCalls}회 · 검색
                    도구 {selectedTask.legal.toolCalls}회 · 검색 결과{' '}
                    {selectedTask.legal.sourceStatus.retrieved}건 · 인용{' '}
                    {selectedTask.legal.citations.length}건
                  </p>
                  {selectedTask.legal.sourceStatus.chain?.length ? (
                    <section
                      className="system-explorer__chain"
                      aria-label="이 작업에서 지식 계층이 이어진 순서"
                    >
                      <h3>이 작업에서 지식 계층이 이어진 순서</h3>
                      <p className="system-explorer__note">
                        각 단계는 앞 단계의 결과를 받아 다음 단계에 넘깁니다.
                        예를 들어 관계 그래프는 관련성 검토를 통과한 조문에서만
                        출발하고, 온톨로지가 허용한 관계만 판례 원문 확인으로
                        이어집니다.
                      </p>
                      <EvidenceChain
                        stages={selectedTask.legal.sourceStatus.chain}
                      />
                    </section>
                  ) : null}
                  {selectedTask.legal.sourceStatus.failures.length ? (
                    <div className="system-explorer__run-materials">
                      <h3>검색 중 확인된 제한</h3>
                      {selectedTask.legal.sourceStatus.failures.map(
                        (failure, index) => (
                          <p key={`${failure.step}:${index}`}>
                            {failure.step} · {failure.message}
                          </p>
                        )
                      )}
                    </div>
                  ) : null}
                </>
              ) : null}
              <WorkflowCanvas task={selectedTask} />
              {selectedTask.legal?.citations.length ? (
                <div className="system-explorer__run-materials">
                  <h3>답변에 실제 인용된 자료</h3>
                  {selectedTask.legal.citations.map((citation) => (
                    <article key={`${citation.corpus}:${citation.recordId}`}>
                      <strong>
                        [{citation.citationId}] {citation.label}
                      </strong>
                      <span>
                        {citation.corpus}
                        {citation.date
                          ? ` · ${citation.date.kind === 'decision' ? '선고' : '개정'} ${citation.date.value}`
                          : ''}
                      </span>
                      {safeHttpUrl(citation.officialUrl) ? (
                        <a
                          href={safeHttpUrl(citation.officialUrl)}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          공식 출처 열기
                        </a>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="system-explorer__note">
              아직 표시할 작업 실행 기록이 없습니다. 채팅에서 작업을 실행하면
              이곳에 기록됩니다.
            </p>
          )}
        </div>
      ) : null}

      {topic === 'rag' ? (
        <div className="system-explorer__content" id="system-rag">
          <h2>RAG 검색</h2>
          <p className="system-explorer__lead">
            색인에 실제 준비된 계층을 표시합니다. 비활성 계층을 사용 중인 것처럼
            취급하지 않습니다.
          </p>
          <ul className="system-explorer__status-list">
            <li>
              <Search />
              <span>
                <b>법령 키워드 검색</b>
                <small>법령·조문 코퍼스</small>
              </span>
              <Status ready={retrieval?.enabled ?? null} label="상태" />
            </li>
            <li>
              <Search />
              <span>
                <b>판례 키워드 검색</b>
                <small>사건명·사건번호·본문 색인</small>
              </span>
              <Status ready={retrieval?.enabled ?? null} label="상태" />
            </li>
            <li>
              <Database />
              <span>
                <b>벡터 검색</b>
                <small>
                  {retrieval?.vector.reason ?? '임베딩 인덱스 상태'}
                </small>
              </span>
              <Status ready={retrieval?.vector.ready ?? null} label="상태" />
            </li>
            <li>
              <Network />
              <span>
                <b>관계 그래프</b>
                <small>
                  {retrieval?.corpus.graphNodes ?? 0} 노드 ·{' '}
                  {retrieval?.corpus.graphEdges ?? 0} 관계
                </small>
              </span>
              <Status
                ready={
                  retrieval?.corpus.graphNodes === null ||
                  retrieval?.corpus.graphNodes === undefined
                    ? null
                    : retrieval.corpus.graphNodes > 0
                }
                label="상태"
              />
            </li>
          </ul>
          {materialBrowser(['all', 'law', 'precedent', 'graph'])}
        </div>
      ) : null}

      {topic === 'wiki' ? (
        <div className="system-explorer__content" id="system-wiki">
          <h2>LLM Wiki · 법률 자료</h2>
          <p className="system-explorer__lead">
            로컬 읽기 전용 Wiki 원문과 검색 인덱스 결과를 함께 확인합니다.
            원문은 페이지 구간으로 불러오며 코퍼스 파일은 수정하지 않습니다.
          </p>
          <div className="system-explorer__wiki-browser">
            <aside
              className="system-explorer__wiki-list"
              aria-label="읽기 전용 Wiki 문서 목록"
            >
              <div className="system-explorer__wiki-list-heading">
                <h3>읽기 전용 Wiki 문서</h3>
                <span>{wikiPages.length.toLocaleString()}개</span>
              </div>
              <input
                type="search"
                aria-label="Wiki 문서 필터"
                placeholder="문서 이름으로 찾기"
                value={wikiFilter}
                onChange={(event) => setWikiFilter(event.target.value)}
              />
              {wikiListLoading ? (
                <p role="status">Wiki 페이지 목록을 읽는 중입니다.</p>
              ) : null}
              {wikiListError ? (
                <div role="alert" className="system-explorer__library-error">
                  <p>{wikiListError}</p>
                  <button
                    type="button"
                    onClick={() => setWikiRetryKey((value) => value + 1)}
                  >
                    다시 불러오기
                  </button>
                </div>
              ) : null}
              {!wikiListLoading && !wikiListError && wikiPages.length === 0 ? (
                <p className="system-explorer__note">
                  {backendStatus === 'online'
                    ? '읽을 수 있는 Markdown Wiki 페이지가 없습니다.'
                    : '백엔드에 연결하면 실제 Wiki 문서 목록이 표시됩니다.'}
                </p>
              ) : null}
              <ul>
                {wikiPages
                  .filter((page) =>
                    page.title
                      .toLocaleLowerCase()
                      .includes(wikiFilter.trim().toLocaleLowerCase())
                  )
                  .map((page) => (
                    <li key={page.name}>
                      <button
                        type="button"
                        aria-pressed={selectedWikiPage === page.name}
                        onClick={() => void loadWikiPage(page.name)}
                      >
                        <span>{page.title}</span>
                        <small>{formatFileSize(page.bytes)}</small>
                      </button>
                    </li>
                  ))}
              </ul>
            </aside>
            <section
              className="system-explorer__wiki-reader"
              aria-label="Wiki 원문"
            >
              {selectedWikiPage ? (
                <>
                  <header>
                    <div>
                      <h3>
                        {wikiPages.find(
                          (page) => page.name === selectedWikiPage
                        )?.title ?? selectedWikiPage}
                      </h3>
                      <code>{selectedWikiPage}</code>
                    </div>
                    {wikiPageChunk ? (
                      <small>
                        {wikiPageChunk.nextOffset.toLocaleString()} /{' '}
                        {wikiPageChunk.totalCharacters.toLocaleString()}자
                      </small>
                    ) : null}
                  </header>
                  {wikiPageLoading && !wikiContent ? (
                    <p role="status">Wiki 원문을 읽는 중입니다.</p>
                  ) : null}
                  {wikiPageError ? (
                    <p role="alert" className="system-explorer__library-error">
                      {wikiPageError}
                    </p>
                  ) : null}
                  {wikiDocument.metadata.length > 0 ? (
                    <details className="system-explorer__wiki-metadata">
                      <summary>문서 정보</summary>
                      <dl>
                        {wikiDocument.metadata.map((field, index) => (
                          <React.Fragment key={`${field.label}-${index}`}>
                            <dt>{field.label}</dt>
                            <dd>{field.value}</dd>
                          </React.Fragment>
                        ))}
                      </dl>
                    </details>
                  ) : null}
                  {wikiDocument.body ? (
                    <MarkdownView value={wikiDocument.body} />
                  ) : null}
                  {wikiPageChunk?.hasMore ? (
                    <button
                      type="button"
                      className="system-explorer__wiki-more"
                      disabled={wikiPageLoading}
                      onClick={() =>
                        void loadWikiPage(
                          selectedWikiPage,
                          wikiPageChunk.nextOffset,
                          true
                        )
                      }
                    >
                      {wikiPageLoading ? '원문을 불러오는 중…' : '원문 더 보기'}
                    </button>
                  ) : null}
                  {!wikiPageLoading &&
                  !wikiPageError &&
                  wikiPageChunk &&
                  !wikiPageChunk.hasMore ? (
                    <p className="system-explorer__note">
                      문서 끝까지 표시했습니다.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="system-explorer__note">
                  목록에서 Wiki 페이지를 선택하면 원문을 읽기 전용으로
                  표시합니다.
                </p>
              )}
            </section>
          </div>
          <h3 className="system-explorer__subheading">법령·판례 색인 검색</h3>
          <p className="system-explorer__note">
            아래 검색은 모델 호출 없이 인덱스에서 관련 레코드를 찾습니다. 전체
            원문은 위 Wiki 브라우저에서 페이지를 골라 확인하세요.
          </p>
          {materialBrowser(['all', 'law', 'precedent'])}
          <p className="system-explorer__note">
            검색 코퍼스의 색인·임베딩은 이 화면에서 변경하지 않습니다.
          </p>
        </div>
      ) : null}

      {topic === 'ontology' ? (
        <div className="system-explorer__content">
          <h2>온톨로지·관계 그래프</h2>
          <p className="system-explorer__lead">
            법령·판례 사이의 명시된 관계를 따라 검색을 보강하는 계층입니다.
          </p>
          <ul className="system-explorer__status-list">
            <li>
              <Network />
              <span>
                <b>온톨로지</b>
                <small>타입·관계 모델</small>
              </span>
              <Status ready={retrieval?.ontology.ready ?? null} label="상태" />
            </li>
            <li>
              <GitBranch />
              <span>
                <b>지식 그래프</b>
                <small>
                  {retrieval?.corpus.graphNodes ?? '—'} 노드 ·{' '}
                  {retrieval?.corpus.graphEdges ?? '—'} 엣지
                </small>
              </span>
              <Status
                ready={
                  retrieval?.corpus.graphNodes === null ||
                  retrieval?.corpus.graphNodes === undefined
                    ? null
                    : retrieval.corpus.graphNodes > 0
                }
                label="상태"
              />
            </li>
          </ul>
          <h3 className="system-explorer__subheading">실제 그래프 검색 결과</h3>
          {materialBrowser(['graph'], true)}
        </div>
      ) : null}

      {topic === 'okf' ? (
        <div className="system-explorer__content">
          <h2>OKF 메타데이터</h2>
          <p className="system-explorer__lead">
            공개 지식 파일의 출처와 식별 정보를 다루는 보조 번들입니다. 실제
            준비 상태는 백엔드 capability 응답을 따릅니다.
          </p>
          <Status ready={retrieval?.okf.ready ?? null} label="OKF 번들" />
          {retrieval?.degraded.length ? (
            <p className="system-explorer__note">
              저하 항목: {retrieval.degraded.join(', ')}
            </p>
          ) : null}
          {catalogLoading ? (
            <p className="system-explorer__note" role="status">
              OKF 카탈로그를 읽는 중입니다.
            </p>
          ) : null}
          {catalogError ? (
            <p className="system-explorer__library-error" role="alert">
              {catalogError}
            </p>
          ) : null}
          {!catalogLoading && !catalogError && !catalogItems.length ? (
            <p className="system-explorer__note">
              백엔드에서 제공한 OKF 카탈로그 문서가 없습니다.
            </p>
          ) : null}
          <div className="system-explorer__catalog">
            {catalogItems.map((entry) => (
              <details
                className="system-explorer__catalog-entry"
                key={entry.name}
                open={entry.name === 'index.md'}
              >
                <summary>
                  <code>{entry.name}</code>
                  <span>
                    {
                      entry.content
                        .split(/\r?\n/u)
                        .filter((line) => line.trim()).length
                    }
                    줄
                  </span>
                </summary>
                <pre>{entry.content}</pre>
              </details>
            ))}
          </div>
          <p className="system-explorer__note">
            카탈로그 원문만 표시합니다. 참조 파일의 준비 여부를 실제 검사한
            것으로 간주하지 않습니다.
          </p>
        </div>
      ) : null}

      {topic === 'mcp' ? (
        <div className="system-explorer__content">
          <h2>MCP·도구 연결</h2>
          <p className="system-explorer__lead">
            법률 검색 도구는 백엔드의 MCP 연결을 통해 호출됩니다. 아래 상태는
            백엔드가 보고한 검색 준비 상태입니다.
          </p>
          <ul className="system-explorer__status-list">
            <li>
              <Workflow />
              <span>
                <b>법률 검색 MCP</b>
                <small>
                  {retrieval?.message ?? '백엔드 연결 후 확인됩니다.'}
                </small>
              </span>
              <Status ready={retrieval?.ready ?? null} label="상태" />
            </li>
          </ul>
          {toolsLoading ? (
            <p className="system-explorer__note" role="status">
              MCP 서버의 도구 목록을 조회하고 있습니다.
            </p>
          ) : null}
          {toolsError ? (
            <p className="system-explorer__library-error" role="alert">
              {toolsError}
            </p>
          ) : null}
          {!toolsLoading && !toolsError && !tools.length ? (
            <p className="system-explorer__note">
              연결된 MCP 서버가 도구 목록을 반환하지 않았습니다.
            </p>
          ) : null}
          {tools.length ? (
            <>
              <h3 className="system-explorer__subheading">
                서버 등록 도구 · {tools.length}
              </h3>
              <ul className="system-explorer__tool-list">
                {tools.map((tool) => (
                  <li key={tool.name}>
                    <code>{tool.name}</code>
                    <span>
                      {tool.description || '서버가 설명을 제공하지 않았습니다.'}
                    </span>
                    {tool.inputSchema ? (
                      <details>
                        <summary>실제 입력 스키마</summary>
                        <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {backendStatus === 'offline' ? (
            <button
              className="system-explorer__retry"
              type="button"
              onClick={onRetry}
            >
              <CircleHelp size={16} />
              연결 다시 확인
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
