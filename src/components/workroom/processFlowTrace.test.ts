import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProcessFlow } from './processFlowModel.js'
import {
  traceReducer,
  initialTraceState,
  TRACE_REFRESH_MS
} from './useTaskTrace.js'
import { seconds, tokenCount } from './traceFormat.js'
import type { TaskTrace, TaskTraceSpan } from '../../api/workroom.js'
import type { LegalAnswerView } from './types.js'

function step(
  name: string,
  startMs: number,
  durationMs: number,
  extra: Partial<TaskTraceSpan> = {}
): TaskTraceSpan {
  return { kind: 'step', name, startMs, durationMs, status: 'ok', ...extra }
}

function llm(
  name: string,
  startMs: number,
  durationMs: number,
  extra: Partial<TaskTraceSpan> = {}
): TaskTraceSpan {
  return { kind: 'llm', name, startMs, durationMs, status: 'ok', ...extra }
}

function trace(spans: TaskTraceSpan[]): TaskTrace {
  return {
    taskId: 't1',
    status: 'completed',
    totalMs: 10_000,
    spans,
    trajectory: []
  }
}

test('the backend stage of a step wins over the name table, so a renamed step is still placed', () => {
  const stages = buildProcessFlow({
    trace: trace([step('새 이름의 단계', 0, 1_000, { stage: 'answer' })])
  })
  assert.equal(stages.length, 1)
  assert.equal(stages[0]!.key, 'answer')
})

test('a model call is listed under the stage whose step time contains its start', () => {
  const stages = buildProcessFlow({
    trace: trace([
      step('검색 계획 수립', 0, 1_000, { stage: 'classify' }),
      step('근거 기반 답변 작성', 1_000, 5_000, { stage: 'answer' }),
      llm('groq · a', 1_200, 800, {
        promptTokens: 1_500,
        completionTokens: 90
      }),
      llm('nvidia · b', 3_000, 2_000)
    ])
  })
  const answer = stages.find((stage) => stage.key === 'answer')!
  assert.ok(
    (answer.calls ?? []).some((line) => line.startsWith('groq · a · 0.8초')),
    'the call inside the answer step is listed there'
  )
  assert.ok(
    (answer.calls ?? []).some((line) =>
      line.includes('입력 1,500 / 출력 90 토큰')
    ),
    'token counts use thousands separators'
  )
  const classify = stages.find((stage) => stage.key === 'classify')!
  assert.equal(
    (classify.calls ?? []).some((line) => line.startsWith('nvidia')),
    false,
    'a call elsewhere is not listed under the wrong stage'
  )
})

test('a call outside every known step is kept under other rather than guessed into a stage', () => {
  const stages = buildProcessFlow({
    trace: trace([llm('orphan · m', 9_000, 500)])
  })
  const other = stages.find((stage) => stage.key === 'other')!
  assert.ok((other.calls ?? []).some((line) => line.startsWith('orphan · m')))
})

test('an estimated start is noted once per stage and a failed call shows its reason', () => {
  const stages = buildProcessFlow({
    trace: trace([
      step('근거 기반 답변 작성', 0, 5_000, { stage: 'answer' }),
      llm('old · m', 1_000, 2_000, { estimated: true }),
      llm('bad · m', 3_000, 500, { status: 'error', detail: 'HTTP 429' })
    ])
  })
  const answerStage = stages.find((stage) => stage.key === 'answer')!
  assert.ok(
    answerStage.details.includes(
      '일부 호출의 시작 시각은 옛 기록이라 추정했습니다'
    ),
    'the estimate is said once for the stage'
  )
  assert.ok(
    (answerStage.calls ?? []).some((line) => line.endsWith('실패: HTTP 429'))
  )
})

test('a reused step says it was reused, and a stage with a cancelled step is shown as cancelled', () => {
  const stages = buildProcessFlow({
    trace: trace([
      step('검색 계획 수립', 0, 0, {
        stage: 'classify',
        detail: '이전 실행에서 재사용'
      }),
      step('근거 기반 답변 작성', 0, 3_000, {
        stage: 'answer',
        status: 'cancelled'
      })
    ])
  })
  assert.ok(
    stages
      .find((stage) => stage.key === 'classify')!
      .details.some((line) => line.endsWith('이전 실행에서 재사용'))
  )
  assert.equal(
    stages.find((stage) => stage.key === 'answer')!.status,
    'cancelled'
  )
})

test('a running step makes its stage running, and an error outranks running', () => {
  const running = buildProcessFlow({
    trace: trace([
      step('근거 기반 답변 작성', 0, 1_000, {
        stage: 'answer',
        status: 'running'
      })
    ])
  })
  assert.equal(running[0]!.status, 'running')
  const mixed = buildProcessFlow({
    trace: trace([
      step('근거 기반 답변 작성', 0, 1_000, {
        stage: 'answer',
        status: 'running'
      }),
      step('근거 기반 답변·초안 작성', 1_000, 500, {
        stage: 'answer',
        status: 'error'
      })
    ])
  })
  assert.equal(mixed[0]!.status, 'error')
})

test('the time and token helpers format the way the flow shows them', () => {
  assert.equal(seconds(3_300), '3.3초')
  assert.equal(tokenCount(3381), '3,381')
})

test('a reload keeps the trace on screen instead of going back to loading', () => {
  const loaded = traceReducer(initialTraceState, {
    type: 'loaded',
    trace: trace([])
  })
  const reloading = traceReducer(loaded, { type: 'start' })
  assert.equal(reloading.phase, 'ready')
  assert.ok(
    reloading.trace,
    'the last trace is still there while the next one is read'
  )
  const failed = traceReducer(reloading, {
    type: 'failed',
    message: '네트워크 오류'
  })
  assert.equal(failed.phase, 'error')
  assert.ok(failed.trace, 'a failed reload keeps the trace it had')
})

test('the first read shows loading, and a failed first read has no trace', () => {
  const started = traceReducer(initialTraceState, { type: 'start' })
  assert.equal(started.phase, 'loading')
  assert.equal(started.trace, undefined)
  const failed = traceReducer(started, { type: 'failed', message: '요청 실패' })
  assert.equal(failed.phase, 'error')
  assert.equal(failed.message, '요청 실패')
})

test('a running task is read again every few seconds', () => {
  assert.equal(TRACE_REFRESH_MS, 3_000)
})

test('while a task runs, stages after the last one that started are pending, and done once it finishes', () => {
  const legal = {
    path: 'direct',
    plannerCalls: 0,
    toolCalls: 1,
    citations: [],
    sourceStatus: {
      retrieved: 1,
      currentness: 'unverified',
      notes: [],
      failures: [],
      degraded: []
    }
  } as unknown as LegalAnswerView
  const running = buildProcessFlow({
    legal,
    taskState: 'running',
    trace: trace([
      step('근거 기반 답변 작성', 0, 1_000, {
        stage: 'answer',
        status: 'running'
      })
    ])
  })
  assert.equal(
    running.find((stage) => stage.key === 'answer')!.status,
    'running'
  )
  assert.equal(
    running.find((stage) => stage.key === 'verify')!.status,
    'pending',
    'verification has not started yet'
  )
  assert.equal(
    running.find((stage) => stage.key === 'classify')!.status,
    'done',
    'a stage before the running one is not pending'
  )

  const finished = buildProcessFlow({
    legal,
    taskState: 'completed',
    trace: trace([
      step('근거 기반 답변 작성', 0, 1_000, { stage: 'answer', status: 'ok' })
    ])
  })
  assert.equal(finished.find((stage) => stage.key === 'verify')!.status, 'done')
})

test('a cancelled task marks the stages it never reached as skipped, not done', () => {
  const legal = {
    path: 'direct',
    plannerCalls: 0,
    toolCalls: 1,
    citations: [],
    sourceStatus: {
      retrieved: 1,
      currentness: 'unverified',
      notes: [],
      failures: [],
      degraded: []
    }
  } as unknown as LegalAnswerView
  const cancelled = buildProcessFlow({
    legal,
    taskState: 'cancelled',
    trace: trace([
      step('근거 기반 답변 작성', 0, 1_000, {
        stage: 'answer',
        status: 'cancelled'
      })
    ])
  })
  assert.equal(
    cancelled.find((stage) => stage.key === 'answer')!.status,
    'cancelled'
  )
  assert.equal(
    cancelled.find((stage) => stage.key === 'verify')!.status,
    'skipped'
  )
})
