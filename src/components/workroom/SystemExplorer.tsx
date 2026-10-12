'use client'

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Activity,
  ArrowRight,
  BookOpen,
  Boxes,
  Braces,
  ChevronDown,
  CircleHelp,
  Database,
  GitBranch,
  Network,
  Route,
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
import MarkdownView from './MarkdownView'
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
  | 'site-flow'
  | 'rag'
  | 'wiki'
  | 'ontology'
  | 'okf'
  | 'mcp'

const topics: { id: SystemTopic; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: '개요', icon: Boxes },
  { id: 'flow', label: '에이전틱 플로우', icon: GitBranch },
  { id: 'site-flow', label: '사이트 동작 흐름', icon: Route },
  { id: 'rag', label: 'RAG 검색', icon: Search },
  { id: 'wiki', label: 'LLM Wiki', icon: BookOpen },
  { id: 'ontology', label: '온톨로지·그래프', icon: Network },
  { id: 'okf', label: 'OKF 메타데이터', icon: Braces },
  { id: 'mcp', label: 'MCP·도구', icon: Workflow }
]

const retrievalLayerLabels: Record<string, string> = {
  used: '이번 작업에서 사용',
  ready: '준비됨 · 미사용',
  degraded: '부분 사용',
  unused: '미사용',
  unavailable: '사용 불가'
}

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

function SiteFlowNode({
  kind = 'step',
  phase,
  title,
  detail,
  meta,
  technologies,
  action,
  status
}: {
  kind?: 'start' | 'step' | 'planner' | 'tool' | 'result'
  phase: string
  title: string
  detail: string
  meta?: string
  technologies?: { name: string; role: string }[]
  action?: { label: string; onClick: () => void }
  status?: string
}) {
  return (
    <article
      className={`site-flow__node site-flow__node--${kind}${status ? ` site-flow__node--${status}` : ''}`}
    >
      <span className="site-flow__node-kind">{phase}</span>
      {status ? (
        <span className="site-flow__node-status">
          {(
            {
              complete: '완료',
              active: '진행 중',
              failed: '실패',
              cancelled: '취소됨',
              waiting: '대기 중',
              empty: '결과 없음'
            } as Record<string, string>
          )[status] ?? status}
        </span>
      ) : null}
      <strong>{title}</strong>
      <small>{detail}</small>
      {technologies?.length ? (
        <dl
          className="site-flow__technologies"
          aria-label="이 단계에서 사용하는 기술"
        >
          {technologies.map((technology) => (
            <div key={technology.name}>
              <dt>{technology.name}</dt>
              <dd>{technology.role}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {meta ? <span className="site-flow__node-meta">{meta}</span> : null}
      {action ? (
        <button
          className="site-flow__node-action"
          type="button"
          onClick={action.onClick}
        >
          {action.label}
          <ArrowRight aria-hidden="true" size={13} />
        </button>
      ) : null}
    </article>
  )
}

function SiteFlowArrow() {
  return (
    <svg
      className="site-flow__arrow"
      viewBox="0 0 64 28"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d="M2 14H62M50 4l12 10-12 10" />
    </svg>
  )
}

function SiteFlowGroup({
  title,
  detail,
  steps
}: {
  title: string
  detail: string
  steps: React.ReactNode[]
}) {
  return (
    <details
      className="site-flow__node site-flow__disclosure"
      aria-label={title}
    >
      <summary>
        <span className="site-flow__disclosure-heading">
          <span className="site-flow__node-kind">
            {steps.length}개 세부 단계
          </span>
          <strong>{title}</strong>
          <small>{detail}</small>
        </span>
        <ChevronDown
          className="site-flow__disclosure-arrow"
          size={20}
          aria-hidden="true"
        />
      </summary>
      <ol
        className="site-flow__disclosure-steps"
        aria-label={`${title} 세부 단계`}
      >
        {steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
    </details>
  )
}

function SiteFlowDiagram({
  groups,
  label = '요청 접수부터 자료 확보, 결과 생성으로 이어지는 처리 순서'
}: {
  groups: { title: string; steps: React.ReactNode[] }[]
  label?: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const markerId = `flow-arrow-${useId().replace(/:/gu, '')}`
  const [geometry, setGeometry] = useState({
    width: 0,
    height: 0,
    paths: [] as string[]
  })

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => {
      const origin = element.getBoundingClientRect()
      const nodes = Array.from(
        element.querySelectorAll<HTMLElement>('[data-flow-step]')
      )
      const paths = nodes.slice(0, -1).map((node, index) => {
        const from = node.getBoundingClientRect()
        const to = nodes[index + 1].getBoundingClientRect()
        const sameColumn = Math.abs(from.left - to.left) < 2
        if (sameColumn) {
          if (
            node.closest('.site-flow__lane') !==
            nodes[index + 1].closest('.site-flow__lane')
          ) {
            const x = from.right - origin.left + 5
            const y = from.top - origin.top + from.height / 2
            const targetY = to.top - origin.top + to.height / 2
            const gutter = origin.width - 12
            return `M ${x} ${y} H ${gutter - 8} Q ${gutter} ${y} ${gutter} ${y + 8} V ${targetY - 8} Q ${gutter} ${targetY} ${gutter - 8} ${targetY} H ${to.right - origin.left + 9}`
          }
          const x = from.left - origin.left + from.width / 2
          return `M ${x} ${from.bottom - origin.top + 5} V ${to.top - origin.top - 9}`
        }
        const startX = from.right - origin.left + 5
        const startY = from.top - origin.top + from.height / 2
        const endX = to.left - origin.left - 9
        const endY = to.top - origin.top + to.height / 2
        if (Math.abs(startY - endY) < 2) {
          return `M ${startX} ${startY} H ${endX}`
        }
        const bendX = (from.right + to.left) / 2 - origin.left
        return `M ${startX} ${startY} H ${bendX - 10} Q ${bendX} ${startY} ${bendX} ${startY - 10} V ${endY + 10} Q ${bendX} ${endY} ${bendX + 10} ${endY} H ${endX}`
      })
      setGeometry({ width: origin.width, height: origin.height, paths })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    element
      .querySelectorAll('[data-flow-step]')
      .forEach((node) => observer.observe(node))
    measure()
    return () => observer.disconnect()
  }, [groups])

  let stepNumber = 0
  return (
    <div
      ref={container}
      className="site-flow__diagram"
      style={{ position: 'relative' }}
      aria-label={label}
    >
      {geometry.width > 0 ? (
        <svg
          className="site-flow__connections"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none'
          }}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          aria-hidden="true"
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 12 12"
              refX="10"
              refY="6"
              markerWidth="12"
              markerHeight="12"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path
                d="M2 2 10 6 2 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </marker>
          </defs>
          {geometry.paths.map((path, index) => (
            <path key={index} d={path} markerEnd={`url(#${markerId})`} />
          ))}
        </svg>
      ) : null}
      {groups.map((group) => (
        <section
          className="site-flow__lane"
          key={group.title}
          aria-label={group.title}
        >
          <h3>{group.title}</h3>
          <ol>
            {group.steps.map((step) => {
              const number = ++stepNumber
              return (
                <li data-flow-step key={number}>
                  <span
                    className="site-flow__step-number"
                    aria-label={`${number}단계`}
                  >
                    {String(number).padStart(2, '0')}
                  </span>
                  {step}
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
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
  kind = 'step'
}: {
  title: string
  detail: string
  meta?: string
  status: string
  kind?: 'start' | 'planner' | 'tool' | 'step' | 'result'
}) {
  return (
    <SiteFlowNode
      kind={kind}
      title={title}
      detail={detail}
      meta={meta}
      status={status}
      phase={
        kind === 'start'
          ? '사용자 요청'
          : kind === 'planner'
            ? '플래너'
            : kind === 'tool'
              ? '검색 도구'
              : kind === 'result'
                ? '결과'
                : '실행 단계'
      }
    />
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
  const flowItems: {
    key: string
    type: 'node'
    node: {
      title: string
      detail: string
      meta?: string
      status: string
      kind?: 'start' | 'planner' | 'step' | 'result'
    }
  }[] = [
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
    ...task.steps.map((step) => ({
      key: step.id,
      type: 'node' as const,
      node: {
        title: step.title,
        detail: stepDetail(step),
        status: stepState(step),
        kind: /plan|계획|요청 정리/iu.test(step.title)
          ? ('planner' as const)
          : ('step' as const)
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

  // Split only at the first result-processing step; never regroup earlier
  // file, planning, or retrieval steps by title and change their order.
  const firstResult = task.steps.findIndex((step) =>
    /analy|generat|write|분석|작성|생성|근거 검증/iu.test(step.title)
  )
  const resultStart = firstResult < 0 ? task.steps.length : firstResult
  const flowGroups = [
    {
      title: '요청 접수',
      steps: [<FlowNode key="request" {...flowItems[0].node} />]
    },
    {
      title: '자료 확보',
      steps: flowItems
        .slice(1, resultStart + 1)
        .map((item) => <FlowNode key={item.key} {...item.node} />)
    },
    {
      title: '결과 생성',
      steps: flowItems
        .slice(resultStart + 1)
        .map((item) => <FlowNode key={item.key} {...item.node} />)
    }
  ]

  return (
    <div className="system-flow site-flow" aria-label="실행 워크플로 그래프">
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
      <p className="site-flow__scroll-hint">
        각 열을 위에서 아래로 읽고 연결선을 따라 이동하세요. 백엔드가 전달한
        단계 순서입니다.
      </p>
      <div className="site-flow__diagram-viewport">
        <SiteFlowDiagram groups={flowGroups} label="백엔드 실행 단계 순서" />
      </div>
      {tools.length > 0 ? (
        <SiteFlowGroup
          title="실제 검색 도구 호출"
          detail={`${tools.length}회 · 백엔드 기록 순서. 실행 단계와 별도로 펼쳐 보는 검색 기록입니다.`}
          steps={tools.map((tool, index) => (
            <FlowNode
              key={`${tool.tool}:${index}`}
              kind="tool"
              title={tool.label}
              detail={`${tool.query ? `질의: ${tool.query} · ` : ''}결과 ${tool.results}건`}
              status={tool.results > 0 ? 'complete' : 'empty'}
            />
          ))}
        />
      ) : null}
      {task.legal?.sourceStatus.ledger?.layers.length ? (
        <section
          className="system-flow__layers"
          aria-label="이번 작업의 검색 계층 사용 현황"
        >
          <header>
            <strong>이번 작업의 검색 계층</strong>
            <span>백엔드가 전달한 실제 사용 기록</span>
          </header>
          <ul>
            {task.legal.sourceStatus.ledger.layers.map((layer) => (
              <li
                className={`system-flow__layer system-flow__layer--${layer.state}`}
                key={layer.id}
              >
                <strong>{layer.label}</strong>
                <span>
                  {retrievalLayerLabels[layer.state] ?? layer.state}
                  {layer.detail ? ` · ${layer.detail}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p>
            {task.legal.sourceStatus.ledger.layers.find(
              (layer) => layer.id === 'wiki'
            )?.state === 'used'
              ? 'LLM Wiki 핵심 조문을 단서로 사용하고 법령 원문을 다시 확인했습니다.'
              : task.legal.sourceStatus.ledger.layers.some(
                    (layer) => layer.id === 'wiki'
                  )
                ? '이번 질문에 맞는 LLM Wiki 핵심 조문이 근거에 추가되지 않았습니다.'
                : '이 작업의 LLM Wiki 사용 기록은 없습니다.'}
          </p>
        </section>
      ) : null}
      {task.legal?.sourceStatus.chain?.length ? (
        <section
          className="system-flow__layers"
          aria-label="실제 근거 처리 순서"
        >
          <header>
            <strong>백엔드가 기록한 근거 처리 순서</strong>
            <span>이번 작업에서 실행된 계층만 표시</span>
          </header>
          <ol className="system-flow__chain">
            {task.legal.sourceStatus.chain.map((stage, index) => (
              <li key={`${stage.id}-${index}`}>
                <strong>{stage.label}</strong>
                <span>{stage.summary}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
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

export default function SystemExplorer({
  capabilities,
  backendStatus,
  onRetry,
  connection,
  tasks,
  topic,
  onTopicChange
}: Props) {
  const retrieval = capabilities?.legalRetrieval
  const [siteFlowPath, setSiteFlowPath] = useState<'law' | 'document'>('law')
  const [libraryQuery, setLibraryQuery] = useState('민법')
  const [libraryCorpus, setLibraryCorpus] = useState<
    'law' | 'precedent' | 'graph' | 'all'
  >('all')
  const [libraryItems, setLibraryItems] = useState<LegalLibraryItem[]>([])
  const [includeGraphContext, setIncludeGraphContext] = useState(false)
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [libraryError, setLibraryError] = useState('')
  const [librarySearchKey, setLibrarySearchKey] = useState('')
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
      autoLoadedTopics.current.has(topic)
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
    let cancelled = false
    setLibraryLoading(true)
    void searchLegalLibrary(initialQuery, corpus, connection)
      .then(({ items }) => {
        if (cancelled) return
        setLibraryItems(items)
        setLibraryError('')
        setLibrarySearchKey(searchKey)
        autoLoadedTopics.current.add(topic)
      })
      .catch(() => {
        if (cancelled) return
        setLibraryError(
          '자료 검색을 완료하지 못했습니다. 백엔드 상태를 확인한 뒤 다시 시도해 주세요.'
        )
      })
      .finally(() => {
        if (!cancelled) setLibraryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [backendStatus, connection, libraryCorpus, topic])

  async function runLibrarySearch(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!libraryQuery.trim()) return
    setLibraryLoading(true)
    setLibraryError('')
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
      setLibraryItems(items)
      setLibrarySearchKey(`${topic}:${corpus}:${libraryQuery}`)
    } catch {
      setLibraryItems([])
      setLibraryError(
        '자료 검색을 완료하지 못했습니다. 백엔드 상태를 확인한 뒤 다시 시도해 주세요.'
      )
    } finally {
      setLibraryLoading(false)
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
          {item.officialUrl ? (
            <a
              href={item.officialUrl}
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
                ? '개념·조문 관계는 찾지 못했습니다. 출처·법원 연결을 포함하면 구조 관계를 확인할 수 있습니다.'
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

  const routeFlowSteps: Record<typeof siteFlowPath, React.ReactNode[]> = {
    law: [
      <SiteFlowNode
        key="legal-files"
        phase="첨부 파일이 있을 때"
        title="첨부 자료 확인"
        detail="첨부 문서의 본문을 추출하고 조사 계획과 답변 문맥에 포함합니다."
      />,
      <SiteFlowNode
        key="legal-plan"
        kind="planner"
        phase="검색 계획"
        title="직접 조회 또는 복합 조사 계획"
        detail="분류된 직접 조회 경로는 별도 플래너 없이 조회합니다. 복합 조사 경로는 첨부 자료 확인 후 모델로 검색 계획을 수립합니다."
      />,
      <SiteFlowNode
        key="legal-rag"
        kind="tool"
        phase="기본 검색"
        title="법령·판례 후보 찾기"
        detail="직접 조회 조건 또는 조사 계획에 따라 조문·사건번호 조회와 키워드·벡터·그래프 검색을 실행합니다."
        technologies={[
          {
            name: 'RAG · 키워드/벡터',
            role: '정확한 용어와 의미가 비슷한 자료를 검색해 모델에 줄 근거를 확보'
          }
        ]}
        meta="준비된 검색 계층만 사용"
        action={{
          label: 'RAG 검색 열기',
          onClick: () => onTopicChange('rag')
        }}
      />,
      <SiteFlowNode
        key="wiki-hints"
        kind="tool"
        phase="조건부 보강"
        title="핵심 조문 보강"
        detail="질문에 맞는 조문이 있으면 법령 원문을 조회해 검색 근거에 더합니다."
        technologies={[
          {
            name: 'LLM Wiki',
            role: '정리된 핵심 조문집의 태그·용어를 질문과 대조해 추가 조회할 조문을 제안'
          }
        ]}
        meta="일치 조문이 있을 때만 추가"
        action={{
          label: 'Wiki 문서 열기',
          onClick: () => onTopicChange('wiki')
        }}
      />,
      <SiteFlowNode
        key="legal-search-supplement"
        phase="조건부 검색 보강"
        title="검색어 재작성·근거 보강"
        detail="직접 검색은 설정에 따라 검색어를 모델로 재작성해 보강합니다. 복합 조사는 부족한 검색을 보완하며, 근거가 적고 그래프가 준비된 경우 관계 검색도 사용할 수 있습니다."
      />,
      <SiteFlowNode
        key="legal-web"
        kind="tool"
        phase="공개 웹 자료가 필요할 때"
        title="참고 URL·웹 검색 본문 확보"
        detail="제공한 URL을 방문하고, 검색어가 있으면 SearXNG 검색 결과 페이지도 방문해 본문을 읽습니다. 법률 근거와 함께 답변에 사용합니다."
      />,
      <SiteFlowNode
        key="legal-evidence-check"
        phase="복합 조사일 때"
        title="계획한 쟁점의 근거 확인"
        detail="계획한 검색별 결과와 실패 기록을 검사하고, 근거를 확보하지 못한 쟁점은 단정하지 않도록 표시합니다."
      />,
      <SiteFlowNode
        key="relevance-filter"
        phase="검색 후 검토"
        title="질문 관련성 확인"
        detail="수집한 법령·판례가 질문과 관련 있는지 검토하고 무관한 후보를 제외합니다."
        technologies={[
          {
            name: 'LLM 관련성 필터',
            role: '검색 결과와 질문을 대조해 다음 관계 탐색에 사용할 조문을 선택'
          }
        ]}
        meta="필터 활성 · 법령·판례 후보 4건 이상 · 사용자가 조문을 지정하지 않은 경우"
      />,
      <SiteFlowNode
        key="relation-graph"
        kind="tool"
        phase="조건부 관계 검증"
        title="조문과 판례 연결 확인"
        detail="관련 조문에서 판례로 이어지는 인용 관계를 찾고, 원문에서도 해당 조문을 인용하는지 확인합니다."
        technologies={[
          { name: '관계 그래프', role: '선택된 조문을 인용한 판례 후보 탐색' },
          {
            name: '온톨로지',
            role: '관계 유형·정의역·치역이 법률 관계 정의에 맞는지 검사'
          },
          { name: 'MCP', role: '판례 원문을 조회해 실제 참조조문 확인' }
        ]}
        meta="관련 조문과 관계가 있을 때 실행"
        action={{
          label: '그래프 탐색 열기',
          onClick: () => onTopicChange('ontology')
        }}
      />
    ],
    document: [
      <SiteFlowNode
        key="document-plan"
        kind="planner"
        phase="계획 수립"
        title="모델로 문서 작업 계획"
        detail="요청을 바탕으로 제목·목차·검색어를 정합니다. 외부 정보가 필요 없는 작업은 검색어를 비웁니다."
      />,
      <SiteFlowNode
        key="file-extract"
        phase="파일 처리"
        title="첨부 문서 본문 추출"
        detail="첨부한 문서에서 읽을 수 있는 내용을 추출합니다."
      />,
      <SiteFlowNode
        key="document-url"
        kind="tool"
        phase="참고 URL이 있을 때"
        title="Browser로 참고 URL 본문 읽기"
        detail="제공한 URL을 방문해 본문을 추출합니다. 파일·URL·웹 검색은 한 작업에서 함께 사용할 수 있습니다."
      />,
      <SiteFlowNode
        key="web-search"
        kind="tool"
        phase="계획에 검색어가 있을 때"
        title="SearXNG 검색"
        detail="계획의 검색어로 공개 웹 자료를 찾습니다. 검색이 필요한데 SearXNG가 미설정이거나 실패하면 작업이 실패합니다."
      />,
      <SiteFlowNode
        key="web-sources"
        kind="tool"
        phase="검색 결과"
        title="검색 결과 페이지 방문·본문 추출"
        detail="검색 결과 URL을 브라우저로 방문합니다. 읽은 본문과 출처를 분석에 전달하고, 본문을 확인하지 못한 페이지는 사실 근거에서 제외합니다."
      />
    ]
  }
  const flowSteps = [
    <SiteFlowNode
      key="user-request"
      kind="start"
      phase="사용자 요청"
      title="문서 작업 요청"
      detail="질문과 참고 파일·링크를 입력하고 작업을 시작합니다."
    />,
    <SiteFlowNode
      key="frontend-submit"
      phase="프론트엔드"
      title="요청·파일 전달"
      detail="첨부 파일과 요청을 백엔드 API로 보냅니다."
      meta="POST /api/files · POST /api/tasks"
    />,
    <SiteFlowNode
      key="backend-dispatch"
      kind="planner"
      phase="백엔드"
      title="작업 접수·분배"
      detail="작업을 저장하고 법률 또는 일반 문서 경로를 시작합니다. 동시 실행은 최대 2개이며 나머지는 대기합니다."
      meta="ApiRouter → TaskService → AgentService"
    />,
    ...routeFlowSteps[siteFlowPath],
    <SiteFlowNode
      key="analyze-sources"
      phase="근거 처리"
      title="요청·자료 분석"
      detail="확인한 자료와 출처를 묶어 답변·문서 작성에 사용할 근거 문맥을 구성합니다."
    />,
    <SiteFlowNode
      key="generate-document"
      kind="planner"
      phase="작성 단계"
      title="답변·문서 생성"
      detail={
        siteFlowPath === 'law'
          ? '확보한 근거로 모델이 답변·초안을 작성하고 인용 규칙을 검사합니다. 오류가 있으면 한 번 수정을 요청합니다. 근거가 없으면 근거 부족 안내 또는 검색 실패로 처리합니다.'
          : '모델이 분석 결과를 바탕으로 Markdown 문서를 작성합니다. 자료가 없는 창작·문서 작업도 가능하며 모델 API 설정이 필요합니다.'
      }
      technologies={[
        {
          name: 'LLM',
          role: '사용자 요청과 확보한 근거를 함께 받아 인용을 포함한 답변·초안 작성'
        }
      ]}
      meta={
        capabilities?.model.configured
          ? '모델 API · 설정됨'
          : '모델 API · 현재 비활성'
      }
    />,
    ...(siteFlowPath === 'law'
      ? [
          <SiteFlowNode
            key="verify-answer"
            phase="생성 후 검증"
            title="주장·인용 확인"
            detail="생성된 답변을 인용 근거와 다시 대조하고, 사용한 자료의 출처를 기록합니다."
            technologies={[
              {
                name: 'LLM 의미 검증',
                role: '인용 문장과 원문을 대조해 근거가 뒷받침하지 않는 문장 제외'
              },
              {
                name: 'OKF 카탈로그',
                role: '인용 자료와 사용한 색인을 카탈로그의 출처 정보에 연결'
              }
            ]}
            meta="검증 수행 여부는 실제 작업 기록에 표시"
          />
        ]
      : [
          <SiteFlowNode
            key="document-citations"
            phase="생성 후 검증"
            title="인용 ID 검사·수정"
            detail="허용된 출처 ID와 인용 유무를 검사하고, 오류가 있으면 모델에 한 번 수정을 요청합니다. 재검사에도 실패하면 작업을 실패 처리합니다."
          />
        ]),
    <SiteFlowNode
      key="save-artifact"
      phase="결과 저장"
      title="DOCX·작업 결과 저장"
      detail="최종 Markdown으로 DOCX를 만들고 작업 결과와 이벤트를 저장합니다."
    />,
    <SiteFlowNode
      key="show-result"
      kind="result"
      phase="결과"
      title="진행·문서 표시"
      detail="실행 중 모든 단계의 진행 이벤트를 SSE로 받아 화면을 갱신합니다. 완료 후 문서 미리보기와 내보내기를 제공합니다."
      technologies={[
        {
          name: 'SSE',
          role: '백엔드의 진행 이벤트와 결과 갱신을 프론트 화면에 전달'
        }
      ]}
      meta="SSE /api/tasks/:id/events"
    />
  ]
  const collectionSteps = routeFlowSteps[siteFlowPath]
  const groupedCollectionSteps =
    siteFlowPath === 'law'
      ? [
          <SiteFlowGroup
            key="prepare"
            title="자료 확인·조사 계획"
            detail="첨부 자료를 읽고 요청에 맞는 조회·조사 경로를 준비합니다."
            steps={collectionSteps.slice(0, 2)}
          />,
          <SiteFlowGroup
            key="retrieve"
            title="법률 근거 검색·보강"
            detail="RAG 검색과 Wiki 조문, 검색어 보강으로 근거 후보를 확보합니다."
            steps={collectionSteps.slice(2, 5)}
          />,
          collectionSteps[5],
          <SiteFlowGroup
            key="verify"
            title="근거 검토·관계 확인"
            detail="쟁점과 질문 관련성을 검토하고 조문·판례의 인용 관계를 확인합니다."
            steps={collectionSteps.slice(6)}
          />
        ]
      : [
          collectionSteps[0],
          <SiteFlowGroup
            key="sources"
            title="첨부 파일·참고 URL 읽기"
            detail="제공한 문서와 링크에서 분석에 사용할 본문을 읽습니다."
            steps={collectionSteps.slice(1, 3)}
          />,
          <SiteFlowGroup
            key="web"
            title="웹 검색·본문 수집"
            detail="SearXNG로 자료를 찾고 검색 결과 페이지의 본문을 읽습니다."
            steps={collectionSteps.slice(3)}
          />
        ]
  const flowGroups = [
    { title: '요청 접수', steps: flowSteps.slice(0, 3) },
    { title: '자료 확보', steps: groupedCollectionSteps },
    {
      title: '결과 생성',
      steps: flowSteps.slice(3 + routeFlowSteps[siteFlowPath].length)
    }
  ]

  return (
    <section
      className={[
        'system-explorer',
        topic === 'site-flow' || topic === 'flow'
          ? 'system-explorer--site-flow'
          : ''
      ]
        .filter(Boolean)
        .join(' ')}
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
              <span>모델 제공자</span>
              <strong>{capabilities?.model.provider ?? '확인 필요'}</strong>
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
                      : id === 'site-flow'
                        ? '화면 요청부터 백엔드 처리와 결과 표시까지'
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
                  · 근거 {selectedTask.sources.length}개
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
                      {citation.officialUrl ? (
                        <a
                          href={citation.officialUrl}
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
            <div className="site-flow">
              <p className="system-explorer__note">
                아직 표시할 작업 실행 기록이 없습니다. 채팅에서 작업을 실행하면
                실제 단계와 상태가 아래 흐름도에 표시됩니다.
              </p>
              <div className="site-flow__diagram-viewport">
                <SiteFlowDiagram
                  label="작업 실행 기록 대기"
                  groups={[
                    {
                      title: '요청 접수',
                      steps: [
                        <SiteFlowNode
                          key="request"
                          phase="기록 대기"
                          title="작업 요청 대기"
                          detail="채팅에서 작업을 시작하면 요청과 참고 자료가 표시됩니다."
                        />
                      ]
                    },
                    {
                      title: '자료 확보',
                      steps: [
                        <SiteFlowNode
                          key="sources"
                          phase="기록 대기"
                          title="계획·검색 기록 대기"
                          detail="백엔드가 전달한 실제 계획과 자료 수집 단계가 표시됩니다."
                        />
                      ]
                    },
                    {
                      title: '결과 생성',
                      steps: [
                        <SiteFlowNode
                          key="result"
                          phase="기록 대기"
                          title="분석·문서 기록 대기"
                          detail="실제 분석·작성 단계와 결과 상태가 표시됩니다."
                        />
                      ]
                    }
                  ]}
                />
              </div>
            </div>
          )}
        </div>
      ) : null}

      {topic === 'site-flow' ? (
        <div className="system-explorer__content site-flow">
          <h2>사이트 동작 흐름</h2>
          <p className="system-explorer__lead">
            백엔드 코드에 따른 처리 순서입니다. 조건부 단계는 생략될 수 있으며,
            실제 실행 여부는 에이전틱 플로우에서 확인하세요.
          </p>

          <div className="site-flow__connection" aria-label="현재 연결 상태">
            <span>백엔드 주소</span>
            <code>{connection.baseUrl}</code>
            <Status
              ready={
                backendStatus === 'online'
                  ? true
                  : backendStatus === 'offline'
                    ? false
                    : null
              }
              label="연결"
            />
            <Status
              ready={capabilities?.model.configured ?? null}
              label="모델"
            />
            <Status
              ready={capabilities?.legalRetrieval.ready ?? null}
              label="법률 검색"
            />
          </div>

          <p className="site-flow__scroll-hint">
            각 열을 위에서 아래로 읽고, 연결선을 따라 다음 열로 이동하세요.
          </p>

          <div className="site-flow__diagram-viewport">
            <div className="site-flow__map" aria-label="사이트 요청 처리 흐름">
              <div className="site-flow__fork-heading">
                <div>
                  <strong>작업 유형별 처리 경로</strong>
                  <span>
                    파일·참고 URL·웹 검색은 한 작업에 함께 포함될 수 있습니다.
                  </span>
                </div>
                <label className="site-flow__path-picker">
                  <span>요청 종류</span>
                  <select
                    aria-label="요청 종류별 흐름 보기"
                    value={siteFlowPath}
                    onChange={(event) =>
                      setSiteFlowPath(event.target.value as typeof siteFlowPath)
                    }
                  >
                    <option value="law">법률 요청</option>
                    <option value="document">일반 문서 요청</option>
                  </select>
                </label>
              </div>

              <SiteFlowDiagram groups={flowGroups} />
            </div>
          </div>

          <aside
            className="site-flow__manual"
            aria-label="LLM Wiki 원문 열람 경로"
          >
            <div className="site-flow__manual-heading">
              <div>
                <span>원문 열람</span>
                <strong>LLM Wiki 자료 확인</strong>
              </div>
              <p>
                법률 작업에서는 질문에 맞는 핵심 조문을 자동으로 찾을 수
                있습니다. 여기서는 Wiki 원문을 직접 열람합니다.
              </p>
            </div>
            <div className="site-flow__manual-track-viewport">
              <div className="site-flow__manual-track">
                <span>사용자가 Wiki 탭 열기</span>
                <SiteFlowArrow />
                <span>Wiki 문서 목록 API</span>
                <SiteFlowArrow />
                <span>페이지 API로 원문 표시</span>
              </div>
            </div>
            <button
              className="site-flow__wiki-action"
              type="button"
              onClick={() => onTopicChange('wiki')}
            >
              Wiki 문서 열기
              <ArrowRight aria-hidden="true" size={14} />
            </button>
            <small>
              읽기 전용 경로 · /api/legal/wiki → /api/legal/wiki/page
            </small>
          </aside>
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
