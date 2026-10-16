import type { TaskTrace, TaskTraceSpan } from '../../api/workroom'
import type { LegalAnswerView, TaskModelUse } from './types'
import { seconds, tokenCount } from './traceFormat'

export type FlowStageKey =
  | 'classify'
  | 'retrieve'
  | 'answer'
  | 'verify'
  | 'other'

/** One stage of the processing flow, in the order it ran. */
export type FlowStage = {
  key: FlowStageKey
  label: string
  status: 'done' | 'error' | 'running' | 'cancelled' | 'pending' | 'skipped'
  durationMs?: number
  summary: string
  details: string[]
  /** The model calls of this stage, one line each; shown folded because a stage can make many. */
  calls?: string[]
}

/**
 * Fallback for trace records from a backend that does not send a stage on each step: the step names it used then.
 * A stage from the backend always wins over this table.
 */
const STEP_STAGE: Record<string, FlowStageKey> = {
  '검색 계획 수립': 'classify',
  '법령·판례 근거 확인': 'retrieve',
  '제한된 근거 수집': 'retrieve',
  '근거 기반 답변 작성': 'answer',
  '근거 기반 답변·초안 작성': 'answer',
  '근거 검증': 'verify'
}

const STAGE_LABEL: Record<FlowStageKey, string> = {
  classify: '질문 분류',
  retrieve: '근거 검색',
  answer: '답변 작성',
  verify: '검토·검증',
  other: '기타 단계'
}

const STAGE_ORDER: FlowStageKey[] = [
  'classify',
  'retrieve',
  'answer',
  'verify',
  'other'
]

const REUSED_DETAIL = '이전 실행에서 재사용'

function stepSpans(trace: TaskTrace | undefined): TaskTraceSpan[] {
  return (trace?.spans ?? []).filter((span) => span.kind === 'step')
}

function stageOfStep(span: TaskTraceSpan): FlowStageKey | undefined {
  return span.stage ?? STEP_STAGE[span.name]
}

function sumDuration(spans: TaskTraceSpan[]): number | undefined {
  return spans.length > 0
    ? spans.reduce((total, span) => total + span.durationMs, 0)
    : undefined
}

/** A stage's status is the most serious state among its steps: error, then running, then cancelled, else done. */
function stageStatus(spans: TaskTraceSpan[]): FlowStage['status'] {
  if (spans.some((span) => span.status === 'error')) return 'error'
  if (spans.some((span) => span.status === 'running')) return 'running'
  if (spans.some((span) => span.status === 'cancelled')) return 'cancelled'
  return 'done'
}

/**
 * The stage a model call belongs to: the stage of the step whose time span contains the call's start. A call that
 * falls outside every known step is listed under "other" rather than guessed into a stage.
 */
function stageOfCall(
  call: TaskTraceSpan,
  steps: TaskTraceSpan[]
): FlowStageKey {
  const owner = steps.find(
    (step) =>
      stageOfStep(step) !== undefined &&
      call.startMs >= step.startMs &&
      call.startMs <= step.startMs + step.durationMs
  )
  return (owner && stageOfStep(owner)) || 'other'
}

function callLine(call: TaskTraceSpan): string {
  const tokens =
    call.promptTokens !== undefined || call.completionTokens !== undefined
      ? ` · 입력 ${tokenCount(call.promptTokens ?? 0)} / 출력 ${tokenCount(call.completionTokens ?? 0)} 토큰`
      : ''
  const failure =
    call.status === 'error'
      ? ` · 실패: ${(call.detail ?? '알 수 없음').slice(0, 80)}`
      : ''
  return `${call.name} · ${seconds(call.durationMs)}${tokens}${failure}`
}

/** Older records have no start time for their calls; say so once per stage instead of on every line. */
function estimateNote(calls: TaskTraceSpan[]): string[] {
  return calls.some((call) => call.estimated)
    ? ['일부 호출의 시작 시각은 옛 기록이라 추정했습니다']
    : []
}

/**
 * Turns what the task already recorded (legal path, search tools, model choice, citations) and the run trace into the
 * stages of one processing flow. Each stage gets the time of the trace steps that belong to it, its model calls, and
 * the steps that were reused from an earlier run. A stage with no data is left out, so a non-legal task shows only what
 * it actually did.
 */
export function buildProcessFlow(input: {
  legal?: LegalAnswerView
  modelUse?: TaskModelUse
  trace?: TaskTrace
  /** The task's state. Stages after the last one that started are still to come while it runs, and never run if it stopped. */
  taskState?: string
}): FlowStage[] {
  const steps = stepSpans(input.trace)
  const calls = (input.trace?.spans ?? []).filter((span) => span.kind === 'llm')
  const byStage = new Map<FlowStageKey, TaskTraceSpan[]>()
  const unknown: TaskTraceSpan[] = []
  for (const span of steps) {
    const key = stageOfStep(span)
    if (key) byStage.set(key, [...(byStage.get(key) ?? []), span])
    else unknown.push(span)
  }
  if (unknown.length > 0)
    byStage.set('other', [...(byStage.get('other') ?? []), ...unknown])

  const callsByStage = new Map<FlowStageKey, TaskTraceSpan[]>()
  for (const call of calls) {
    const key = stageOfCall(call, steps)
    callsByStage.set(key, [...(callsByStage.get(key) ?? []), call])
  }

  const stages: Partial<Record<FlowStageKey, FlowStage>> = {}
  const { legal, modelUse } = input

  if (legal) {
    stages.classify = {
      key: 'classify',
      label: STAGE_LABEL.classify,
      status: 'done',
      summary:
        legal.path === 'orchestrated' ? '여러 쟁점으로 나눠 조회' : '직접 조회',
      details: [
        legal.plannerCalls > 0
          ? `계획 모델 ${legal.plannerCalls}회`
          : '계획 모델 미사용'
      ],
      durationMs: undefined
    }
    const ledger = legal.sourceStatus.ledger
    const usedLayers = (ledger?.layers ?? [])
      .filter((layer) => layer.state === 'used')
      .map((layer) => layer.label)
    stages.retrieve = {
      key: 'retrieve',
      label: STAGE_LABEL.retrieve,
      status: 'done',
      summary: `검색 도구 ${legal.toolCalls}회 · 근거 ${legal.sourceStatus.retrieved}건`,
      details: [
        ...(usedLayers.length > 0
          ? [`사용 계층: ${usedLayers.join(', ')}`]
          : []),
        ...(ledger?.tools ?? []).map(
          (tool) => `${tool.tool} · ${tool.query} → ${tool.results}건`
        )
      ],
      durationMs: undefined
    }
    stages.verify = {
      key: 'verify',
      label: STAGE_LABEL.verify,
      status: 'done',
      summary: `인용 ${legal.citations.length}건`,
      details: [
        legal.sourceStatus.currentness === 'record-dated'
          ? '기록에 적힌 날짜로만 확인'
          : '색인이 현행 여부를 확인하지 않음'
      ],
      durationMs: undefined
    }
  }

  if (legal || modelUse) {
    const totals = modelUse?.totals
    stages.answer = {
      key: 'answer',
      label: STAGE_LABEL.answer,
      status: 'done',
      summary: `응답 모델 ${modelUse?.finalModel ?? '없음'}`,
      details: [
        ...(modelUse?.fellBack
          ? [`실패 후 대체 · 실패 모델: ${modelUse.failedModels.join(', ')}`]
          : []),
        ...(totals
          ? [
              `모델 호출 ${totals.calls}회 · 토큰 ${tokenCount(totals.promptTokens + totals.completionTokens)}`
            ]
          : [])
      ],
      durationMs: undefined
    }
  }

  for (const key of STAGE_ORDER) {
    const stageSpans = byStage.get(key)
    const stageCalls = callsByStage.get(key) ?? []
    if (!stageSpans && stageCalls.length === 0) continue
    const spans = stageSpans ?? []
    const reused = spans.filter((span) => span.detail === REUSED_DETAIL)
    const reusedLines = reused.map((span) => `${span.name} · ${REUSED_DETAIL}`)
    const callLines = stageCalls.map(callLine)
    const existing = stages[key]
    const note = estimateNote(stageCalls)
    if (existing) {
      stages[key] = {
        ...existing,
        status: spans.length > 0 ? stageStatus(spans) : existing.status,
        durationMs: sumDuration(spans) ?? existing.durationMs,
        details: [...existing.details, ...reusedLines, ...note],
        calls: callLines
      }
    } else if (key === 'other') {
      stages.other = {
        key,
        label: STAGE_LABEL.other,
        status: stageStatus(spans),
        durationMs: sumDuration(spans),
        summary: `${spans.length}개 단계`,
        details: [...spans.map((span) => span.name), ...reusedLines, ...note],
        calls: callLines
      }
    } else {
      stages[key] = {
        key,
        label: STAGE_LABEL[key],
        status: stageStatus(spans),
        durationMs: sumDuration(spans),
        summary: spans.map((span) => span.name).join(' · '),
        details: [...reusedLines, ...note],
        calls: callLines
      }
    }
  }

  // A stage after the last one that has started has not run yet: pending while the task runs, skipped if it stopped first.
  const stopped =
    input.taskState === 'cancelled' || input.taskState === 'failed'
  const stillToRun =
    input.taskState === 'queued' || input.taskState === 'running' || stopped
  const started = STAGE_ORDER.map((key, index) =>
    byStage.has(key) ? index : -1
  ).reduce((latest, index) => Math.max(latest, index), -1)
  return STAGE_ORDER.map((key, index) => ({ key, index, stage: stages[key] }))
    .filter(
      (
        entry
      ): entry is { key: FlowStageKey; index: number; stage: FlowStage } =>
        Boolean(entry.stage)
    )
    .map(({ key, index, stage }) =>
      !byStage.has(key) && index > started && stillToRun
        ? {
            calls: [],
            ...stage,
            status: stopped ? ('skipped' as const) : ('pending' as const)
          }
        : { calls: [], ...stage }
    )
}
