import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TaskTrace, { traceBars } from './TaskTrace.js'
import type { TaskTrace as TraceData } from '../../api/workroom.js'

const trace: TraceData = {
  taskId: 't1',
  status: 'completed',
  totalMs: 10_000,
  spans: [
    {
      kind: 'step',
      name: '근거 검색',
      startMs: 0,
      durationMs: 2_000,
      status: 'ok'
    },
    {
      kind: 'llm',
      name: 'groq · a',
      startMs: 2_500,
      durationMs: 2_500,
      status: 'error',
      detail: '분당 한도'
    },
    {
      kind: 'error',
      name: '검증 실패',
      startMs: 9_000,
      durationMs: 0,
      status: 'error'
    }
  ],
  trajectory: [
    { order: 1, offsetMs: 0, title: '질문 분류', detail: '직접 조회' }
  ]
}

test('spans are placed as percentages of the whole run, and an instant failure stays visible', () => {
  assert.deepEqual(
    traceBars(trace).map((bar) => [bar.left, bar.width]),
    [
      [0, 20],
      [25, 25],
      [90, 1]
    ]
  )
})

test('a zero-length run does not divide by zero', () => {
  const bars = traceBars({
    ...trace,
    totalMs: 0,
    spans: [
      { kind: 'step', name: 's', startMs: 0, durationMs: 0, status: 'ok' }
    ]
  })
  assert.deepEqual(
    bars.map((bar) => bar.width),
    [1]
  )
})

test('the panel renders closed, with no alert and no request until it is opened', () => {
  const html = renderToStaticMarkup(
    createElement(TaskTrace, {
      taskId: 't1',
      connection: { baseUrl: 'http://x', token: '' }
    })
  )
  assert.match(html, /실행 추적/)
  assert.doesNotMatch(html, /role="alert"/)
  assert.doesNotMatch(html, /task-trace__body/)
})
