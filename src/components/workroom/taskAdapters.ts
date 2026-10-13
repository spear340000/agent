import type {
  BackendEvent,
  BackendTask,
  LegalAnswer,
  LegalChainStage,
  LegalLedger,
  TaskDetails
} from '@/api/workroom'
import { LEGAL_CHAIN_STAGE_IDS } from '@/api/workroom'
import type {
  LegalAnswerView,
  TaskActivity,
  TaskModelUse,
  Source,
  Task,
  TaskMessage,
  TaskStep,
  WorkflowStage
} from './types'
import { friendlyTaskError } from './displayText'

const stageByStep: WorkflowStage[] = [
  'planning',
  'collecting',
  'collecting',
  'analyzing',
  'writing',
  'writing'
]

function stageForTask(task: BackendTask): WorkflowStage {
  if (task.status === 'completed') return 'completed'
  const activeIndex = task.steps.findIndex(
    (step) =>
      step.status === 'running' ||
      step.status === 'failed' ||
      step.status === 'cancelled'
  )
  const pendingIndex = task.steps.findIndex((step) => step.status === 'pending')
  const index = activeIndex >= 0 ? activeIndex : pendingIndex
  const title = task.steps[index]?.title ?? ''
  if (/plan|계획|요청 정리/iu.test(title)) return 'planning'
  if (/analy|분석|근거 검증/iu.test(title)) return 'analyzing'
  if (/generat|write|작성|생성/iu.test(title)) return 'writing'
  if (/read|research|collect|첨부|수집|검색|근거 확인|자료 확인/iu.test(title))
    return 'collecting'
  return stageByStep[index] ?? 'planning'
}

function messagesFromEvents(events: BackendEvent[]): TaskMessage[] {
  return events.flatMap((event) => {
    if (event.type !== 'task.revised') return []
    const kind = event.metadata?.kind
    const message = event.metadata?.message
    if (
      (kind !== 'revision' && kind !== 'followup') ||
      typeof message !== 'string'
    ) {
      return []
    }
    return [
      {
        id: String(event.id),
        kind,
        text: message,
        createdAt: Date.parse(event.createdAt) || 0
      }
    ]
  })
}

const FILE_STEP_TITLES = ['Read source files', '첨부 자료 확인']
const LINK_STEP_TITLES = ['Research the web', '공개 웹 자료 확인']

function sourceState(
  task: BackendTask,
  step: BackendTask['steps'][number] | undefined
): Source['status'] {
  if (step?.status === 'failed') return 'error'
  if (step?.status === 'completed' || task.status === 'completed')
    return 'ready'
  if (task.status === 'running' && step?.status === 'running')
    return 'collecting'
  return 'queued'
}

function sourceList(task: BackendTask, previous: Source[] = []): Source[] {
  const priorFiles = new Map(
    previous
      .filter((source) => source.kind === 'file')
      .map((source) => [source.fileId ?? source.id, source] as const)
  )
  const fileStatus = sourceState(
    task,
    task.steps.find((step) => FILE_STEP_TITLES.includes(step.title))
  )
  const files = task.sourceFileIds.map((fileId) => {
    const prior = priorFiles.get(fileId)
    return {
      id: fileId,
      fileId,
      name: prior?.name ?? fileId,
      kind: 'file' as const,
      status: fileStatus
    }
  })
  const linkStatus = sourceState(
    task,
    task.steps.find((step) => LINK_STEP_TITLES.includes(step.title))
  )
  const links = task.sourceUrls.map((url) => {
    const prior = previous.find(
      (source) => source.kind === 'link' && source.url === url
    )
    let hostname = url
    try {
      hostname = new URL(url).hostname
    } catch {
      // Keep historical source values visible if an older task contains one.
    }
    return {
      id: url,
      name: prior?.name ?? hostname,
      kind: 'link' as const,
      url,
      status: linkStatus
    }
  })
  return [...files, ...links]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const LEDGER_LAYER_IDS = [
  'law-keyword',
  'precedent-keyword',
  'vector',
  'graph',
  'ontology',
  'okf',
  'wiki'
] as const
const LEDGER_STATES = [
  'used',
  'ready',
  'degraded',
  'unused',
  'unavailable'
] as const

/** Stages of how the evidence was built; unknown stage ids from a newer backend are skipped, not fatal. */
export function chainFrom(value: unknown): LegalChainStage[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).flatMap((stage) => {
    const id = String(stage.id)
    if (!LEGAL_CHAIN_STAGE_IDS.includes(id as LegalChainStage['id'])) return []
    return [
      {
        id: id as LegalChainStage['id'],
        label: String(stage.label ?? id),
        summary: String(stage.summary ?? ''),
        items: Array.isArray(stage.items) ? stage.items.map(String) : []
      }
    ]
  })
}

function ledgerFrom(value: unknown): LegalLedger | undefined {
  if (!isRecord(value)) return undefined
  const layers = Array.isArray(value.layers)
    ? value.layers.filter(isRecord).flatMap((layer) => {
        const id = String(layer.id ?? '')
        if (!LEDGER_LAYER_IDS.includes(id as (typeof LEDGER_LAYER_IDS)[number]))
          return []
        const state = String(layer.state ?? '')
        return [
          {
            id: id as LegalLedger['layers'][number]['id'],
            label: String(layer.label ?? id),
            state: (LEDGER_STATES.includes(
              state as (typeof LEDGER_STATES)[number]
            )
              ? state
              : 'ready') as LegalLedger['layers'][number]['state'],
            detail: String(layer.detail ?? '')
          }
        ]
      })
    : []
  const planner = isRecord(value.planner) ? value.planner : undefined
  return {
    layers,
    tools: Array.isArray(value.tools)
      ? value.tools.filter(isRecord).map((tool) => ({
          tool: String(tool.tool ?? ''),
          label: String(tool.label ?? ''),
          query: String(tool.query ?? ''),
          results: typeof tool.results === 'number' ? tool.results : 0
        }))
      : [],
    toolCalls: typeof value.toolCalls === 'number' ? value.toolCalls : 0,
    maxToolCalls:
      typeof value.maxToolCalls === 'number' ? value.maxToolCalls : 0,
    planner: {
      calls: planner && typeof planner.calls === 'number' ? planner.calls : 0,
      mode: planner?.mode === 'used' ? 'used' : 'not-used'
    }
  }
}

const ACTIVITY_TYPES = new Set([
  'legal.routed',
  'legal.retrieval',
  'legal.answer',
  'step.started',
  'step.completed',
  'task.progress'
])

/** Backend events worth showing a person while they wait: routing, retrieval and step changes. */
export function activityFromEvents(events: BackendEvent[]): TaskActivity[] {
  return events
    .filter((event) => ACTIVITY_TYPES.has(event.type) && event.title)
    .map((event) => {
      const items = Array.isArray(event.metadata?.items)
        ? event.metadata.items.map(String)
        : []
      return {
        id: String(event.id),
        at: Date.parse(event.createdAt) || 0,
        title: event.title,
        detail: event.type.startsWith('step.') ? '' : event.message,
        ...(items.length > 0 ? { items } : {})
      }
    })
    .slice(-60)
}

export function modelUseFromEvents(
  events: BackendEvent[]
): TaskModelUse | undefined {
  const metadata = [...events]
    .reverse()
    .find((item) => item.type === 'model.attempts')?.metadata
  if (!isRecord(metadata)) return undefined
  const attempts = Array.isArray(metadata.attempts)
    ? metadata.attempts.filter(isRecord)
    : []
  const failedModels = [
    ...new Set(
      attempts
        .filter((attempt) => attempt.ok === false)
        .map((attempt) => String(attempt.model))
    )
  ]
  const totals = isRecord(metadata.totals) ? metadata.totals : undefined
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  return {
    finalModel:
      typeof metadata.finalModel === 'string' ? metadata.finalModel : null,
    fellBack: metadata.fellBack === true,
    failedModels,
    ...(totals
      ? {
          totals: {
            calls: count(totals.calls),
            failedCalls: count(totals.failedCalls),
            promptTokens: count(totals.promptTokens),
            completionTokens: count(totals.completionTokens),
            totalMs: count(totals.totalMs),
            tokensPerSecond:
              typeof totals.tokensPerSecond === 'number'
                ? totals.tokensPerSecond
                : null
          }
        }
      : {})
  }
}

export function legalAnswerFromEvents(
  events: BackendEvent[]
): LegalAnswerView | undefined {
  const event = [...events]
    .reverse()
    .find(
      (item) => item.type === 'legal.answer' || item.type === 'legal.retrieval'
    )
  const metadata = event?.metadata
  if (!isRecord(metadata)) return undefined
  const sourceStatus = metadata.sourceStatus
  if (!isRecord(sourceStatus)) return undefined
  const citations = Array.isArray(metadata.citations)
    ? metadata.citations.filter(isRecord).map((citation) => ({
        citationId: String(citation.citationId ?? ''),
        recordId: String(citation.recordId ?? ''),
        corpus: (typeof citation.corpus === 'string'
          ? citation.corpus
          : 'law') as LegalAnswer['citations'][number]['corpus'],
        label: String(citation.label ?? ''),
        ...(typeof citation.officialUrl === 'string'
          ? { officialUrl: citation.officialUrl }
          : {}),
        ...(isRecord(citation.date) &&
        typeof citation.date.value === 'string' &&
        (citation.date.kind === 'amendment' ||
          citation.date.kind === 'decision')
          ? {
              date: {
                kind: citation.date.kind as 'amendment' | 'decision',
                value: citation.date.value
              }
            }
          : {}),
        ...(Array.isArray(citation.provenance)
          ? {
              provenance: citation.provenance.filter(
                (item): item is string => typeof item === 'string'
              )
            }
          : {})
      }))
    : []
  return {
    intent: String(metadata.intent ?? 'legal-question'),
    path: metadata.path === 'orchestrated' ? 'orchestrated' : 'direct',
    answer: typeof metadata.answer === 'string' ? metadata.answer : '',
    citations,
    sourceStatus: {
      corpusReady: sourceStatus.corpusReady === true,
      retrieved:
        typeof sourceStatus.retrieved === 'number'
          ? sourceStatus.retrieved
          : citations.length,
      ...(typeof sourceStatus.cited === 'number'
        ? { cited: sourceStatus.cited }
        : {}),
      degraded: Array.isArray(sourceStatus.degraded)
        ? sourceStatus.degraded.map(String)
        : [],
      currentness:
        sourceStatus.currentness === 'record-dated'
          ? 'record-dated'
          : 'unverified',
      notes: Array.isArray(sourceStatus.notes)
        ? sourceStatus.notes.map(String)
        : [],
      failures: Array.isArray(sourceStatus.failures)
        ? sourceStatus.failures.filter(isRecord).map((failure) => ({
            step: String(failure.step ?? ''),
            kind: String(failure.kind ?? ''),
            message: String(failure.message ?? '')
          }))
        : [],
      ...(() => {
        const ledger = ledgerFrom(sourceStatus.ledger)
        return ledger ? { ledger } : {}
      })(),
      ...(() => {
        const chain = chainFrom(sourceStatus.chain)
        return chain.length ? { chain } : {}
      })()
    },
    plannerCalls: metadata.plannerCalls === 1 ? 1 : 0,
    toolCalls: typeof metadata.toolCalls === 'number' ? metadata.toolCalls : 0,
    ...(typeof metadata.artifactId === 'string'
      ? { artifactId: metadata.artifactId }
      : {}),
    ...(typeof metadata.fileId === 'string' ? { fileId: metadata.fileId } : {})
  }
}

export function toWorkroomTask(
  details: TaskDetails,
  previous?: Partial<
    Pick<
      Task,
      | 'sources'
      | 'messages'
      | 'document'
      | 'documentDirty'
      | 'documentDraftBase'
      | 'documentDraftConflict'
      | 'savedDocument'
      | 'revisionBaseline'
    >
  >
): Task {
  const { task } = details
  const artifact = details.artifacts
    .filter((item) => item.kind === 'document')
    .reduce<
      (typeof details.artifacts)[number] | undefined
    >((latest, item) => (!latest || item.createdAt.localeCompare(latest.createdAt) >= 0 ? item : latest), undefined)
  const messageMap = new Map(
    (previous?.messages ?? []).map((message) => [message.id, message])
  )
  const events = Array.isArray(details.events) ? details.events : []
  for (const message of messagesFromEvents(events)) {
    const previousMessage = messageMap.get(message.id)
    messageMap.set(
      message.id,
      previousMessage?.changeSummary
        ? { ...message, changeSummary: previousMessage.changeSummary }
        : message
    )
  }
  const savedDocument = artifact?.content ?? ''
  const documentDirty = previous?.documentDirty ?? false
  const steps: TaskStep[] = task.steps.map((step) => ({
    id: step.id,
    title: step.title,
    status: step.status,
    progress: step.progress,
    ...(step.error === undefined ? {} : { error: step.error })
  }))

  return {
    id: task.id,
    title: task.title,
    request: task.prompt,
    sources: sourceList(task, previous?.sources),
    messages: [...messageMap.values()].sort(
      (left, right) => left.createdAt - right.createdAt
    ),
    ...(previous?.revisionBaseline === undefined
      ? {}
      : { revisionBaseline: previous.revisionBaseline }),
    steps,
    stage: stageForTask(task),
    state: task.status,
    document: documentDirty
      ? (previous?.document ?? savedDocument)
      : savedDocument,
    savedDocument,
    documentDirty,
    documentDraftBase: documentDirty
      ? (previous?.documentDraftBase ??
        previous?.savedDocument ??
        savedDocument)
      : undefined,
    documentDraftConflict: previous?.documentDraftConflict,
    artifactFileId: artifact?.fileId,
    artifactName: artifact?.name,
    artifactMimeType: artifact?.mimeType,
    sourceFileIds: [...task.sourceFileIds],
    documentType: 'md',
    createdAt: Date.parse(task.createdAt) || 0,
    updatedAt: Date.parse(task.updatedAt) || 0,
    error: task.error ? friendlyTaskError(task.error) : task.error,
    ...(() => {
      const legal = legalAnswerFromEvents(events)
      return legal ? { legal } : {}
    })(),
    ...(events.length > 0 ? { activity: activityFromEvents(events) } : {}),
    ...(() => {
      const modelUse = modelUseFromEvents(events)
      if (!modelUse) return {}
      const totals = modelUse.totals
      // The usage panel's totals are the backend's real per-task model totals; per-stage rows stay empty until the
      // backend attributes calls to steps.
      return {
        modelUse,
        ...(totals && totals.calls > 0
          ? {
              usageMetrics: {
                totalTokenCount: totals.promptTokens + totals.completionTokens,
                totalDurationMs: totals.totalMs
              }
            }
          : {})
      }
    })()
  }
}

function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of lines) {
    if (!line.trim()) continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}

function takeLine(counts: Map<string, number>, line: string): boolean {
  const count = counts.get(line) ?? 0
  if (count === 0) return false
  if (count === 1) counts.delete(line)
  else counts.set(line, count - 1)
  return true
}

export function summarizeDocumentChanges(
  previousDocument: string,
  updatedDocument: string
): NonNullable<Task['messages'][number]['changeSummary']> {
  const previousLines = previousDocument.split(/\r\n|\n|\r/)
  const updatedLines = updatedDocument.split(/\r\n|\n|\r/)
  const oldLineCounts = countLines(previousLines)
  const newLineCounts = countLines(updatedLines)
  const addedCounts = new Map(oldLineCounts)
  const removedCounts = new Map(newLineCounts)
  const added: string[] = []
  const removed: string[] = []
  let section = '문서 본문'
  const locations = new Set<string>()

  for (const line of updatedLines) {
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
    if (heading) {
      section = heading[1]!.trim()
      if (!takeLine(addedCounts, line)) locations.add(section)
      continue
    }
    if (!line.trim() || takeLine(addedCounts, line)) continue
    locations.add(section)
    if (added.length < 2) added.push(line.trim())
  }

  section = '문서 본문'
  for (const line of previousLines) {
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
    if (heading) {
      section = heading[1]!.trim()
      if (!takeLine(removedCounts, line)) locations.add(section)
      continue
    }
    if (!line.trim() || takeLine(removedCounts, line)) continue
    locations.add(section)
    if (removed.length < 2) removed.push(line.trim())
  }

  const changes = [
    ...added.map((line) => `추가·보완: ${line}`),
    ...removed.map((line) => `수정 전 내용: ${line}`)
  ].slice(0, 3)

  return {
    location: [...locations].slice(0, 3).join(' · ') || '문서 본문',
    changes: changes.length > 0 ? changes : ['문서 본문에 확인된 변경 없음'],
    method:
      added.length > 0
        ? '추가 요청 내용을 해당 항목에 반영하고 관련 문장을 보완했습니다.'
        : '추가 요청에 맞춰 기존 문장을 수정했습니다.'
  }
}

export function toTaskSummary(task: BackendTask): Task {
  return toWorkroomTask({ task, events: [], artifacts: [] })
}
