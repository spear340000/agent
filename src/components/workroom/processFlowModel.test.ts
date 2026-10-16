import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProcessFlow } from './processFlowModel.js'
import type { TaskTrace, TaskTraceSpan } from '../../api/workroom.js'
import type { LegalAnswerView, TaskModelUse } from './types.js'

const legal = {
  intent: 'law',
  path: 'orchestrated',
  answer: '',
  citations: [{ citationId: 'L1' }],
  sourceStatus: {
    corpusReady: true,
    retrieved: 3,
    cited: 1,
    degraded: [],
    currentness: 'unverified',
    notes: [],
    failures: [],
    ledger: {
      layers: [{ id: 'rag', label: 'RAG', state: 'used', detail: '' }],
      tools: [
        { tool: 'search_laws', label: '법령', query: '손해배상', results: 2 }
      ],
      toolCalls: 2,
      maxToolCalls: 12,
      planner: { calls: 1, mode: 'used' }
    }
  },
  plannerCalls: 1,
  toolCalls: 2
} as unknown as LegalAnswerView

const modelUse: TaskModelUse = {
  finalModel: 'nemotron',
  fellBack: true,
  failedModels: ['gpt-oss-120b'],
  totals: {
    calls: 3,
    failedCalls: 1,
    promptTokens: 100,
    completionTokens: 50,
    totalMs: 900,
    tokensPerSecond: null
  }
}

function span(
  name: string,
  durationMs: number,
  status: TaskTraceSpan['status'] = 'ok'
): TaskTraceSpan {
  return { kind: 'step', name, startMs: 0, durationMs, status }
}

const trace: TaskTrace = {
  taskId: 't1',
  status: 'completed',
  totalMs: 10_000,
  spans: [
    span('검색 계획 수립', 1_000),
    span('법령·판례 근거 확인', 2_000),
    span('근거 기반 답변 작성', 5_000),
    span('근거 검증', 500)
  ],
  trajectory: []
}

test('a legal task runs through classify, retrieve, answer and verify in that order, with each stage timed', () => {
  const stages = buildProcessFlow({ legal, modelUse, trace })
  assert.deepEqual(
    stages.map((stage) => stage.key),
    ['classify', 'retrieve', 'answer', 'verify']
  )
  assert.deepEqual(
    stages.map((stage) => stage.durationMs),
    [1_000, 2_000, 5_000, 500]
  )
  assert.equal(stages[1]!.summary, '검색 도구 2회 · 근거 3건')
  assert.ok(stages[1]!.details.includes('search_laws · 손해배상 → 2건'))
})

test('a fallback shows the models that failed and the one that answered', () => {
  const answer = buildProcessFlow({ legal, modelUse, trace }).find(
    (stage) => stage.key === 'answer'
  )!
  assert.equal(answer.summary, '응답 모델 nemotron')
  assert.ok(answer.details.some((line) => line.includes('gpt-oss-120b')))
})

test('a step the flow does not know is kept under other, not dropped', () => {
  const extra: TaskTrace = {
    ...trace,
    spans: [...trace.spans, span('새 단계', 300)]
  }
  const other = buildProcessFlow({ legal, modelUse, trace: extra }).find(
    (stage) => stage.key === 'other'
  )!
  assert.equal(other.durationMs, 300)
  assert.deepEqual(other.details, ['새 단계'])
})

test('a failed step marks its stage as an error', () => {
  const failed: TaskTrace = {
    ...trace,
    spans: trace.spans.map((item) =>
      item.name === '근거 기반 답변 작성' ? { ...item, status: 'error' } : item
    )
  }
  const answer = buildProcessFlow({ legal, modelUse, trace: failed }).find(
    (stage) => stage.key === 'answer'
  )!
  assert.equal(answer.status, 'error')
})

test('without a trace the stages still appear, just without times', () => {
  const stages = buildProcessFlow({ legal, modelUse })
  assert.equal(stages.length, 4)
  assert.ok(stages.every((stage) => stage.durationMs === undefined))
})

test('a task with no legal answer and no trace has no flow', () => {
  assert.deepEqual(buildProcessFlow({}), [])
})
