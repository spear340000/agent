import type { TaskTrace, TaskTraceSpan } from '../../api/workroom'
import type { LegalAnswerView, TaskModelUse } from './types'

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
  status: 'done' | 'error'
  durationMs?: number
  summary: string
  details: string[]
}

/** Which backend step (as the trace names it) belongs to which stage. Unknown step names go to 'other', not dropped. */
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

function stepSpans(trace: TaskTrace | undefined): TaskTraceSpan[] {
  return (trace?.spans ?? []).filter((span) => span.kind === 'step')
}

function sumDuration(spans: TaskTraceSpan[]): number | undefined {
  return spans.length > 0
    ? spans.reduce((total, span) => total + span.durationMs, 0)
    : undefined
}

/**
 * Turns what the task already recorded (legal path, search tools, model choice, citations) and the run trace into the
 * stages of one processing flow. Each stage gets the time of the trace steps that belong to it. A stage with no data
 * is left out, so a non-legal task shows only what it actually did.
 */
export function buildProcessFlow(input: {
  legal?: LegalAnswerView
  modelUse?: TaskModelUse
  trace?: TaskTrace
}): FlowStage[] {
  const spans = stepSpans(input.trace)
  const byStage = new Map<FlowStageKey, TaskTraceSpan[]>()
  const unknown: TaskTraceSpan[] = []
  for (const span of spans) {
    const key = STEP_STAGE[span.name]
    if (key) byStage.set(key, [...(byStage.get(key) ?? []), span])
    else unknown.push(span)
  }
  if (unknown.length > 0)
    byStage.set('other', [...(byStage.get('other') ?? []), ...unknown])

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
              `모델 호출 ${totals.calls}회 · 토큰 ${totals.promptTokens + totals.completionTokens}`
            ]
          : [])
      ],
      durationMs: undefined
    }
  }

  for (const key of STAGE_ORDER) {
    const stageSpans = byStage.get(key)
    if (!stageSpans) continue
    const failed = stageSpans.some((span) => span.status === 'error')
    const existing = stages[key]
    if (existing) {
      stages[key] = {
        ...existing,
        status: failed ? 'error' : existing.status,
        durationMs: sumDuration(stageSpans)
      }
    } else if (key === 'other') {
      stages.other = {
        key,
        label: STAGE_LABEL.other,
        status: failed ? 'error' : 'done',
        durationMs: sumDuration(stageSpans),
        summary: `${stageSpans.length}개 단계`,
        details: stageSpans.map((span) => span.name)
      }
    } else {
      stages[key] = {
        key,
        label: STAGE_LABEL[key],
        status: failed ? 'error' : 'done',
        durationMs: sumDuration(stageSpans),
        summary: stageSpans.map((span) => span.name).join(' · '),
        details: []
      }
    }
  }

  return STAGE_ORDER.map((key) => stages[key]).filter(
    (stage): stage is FlowStage => Boolean(stage)
  )
}
