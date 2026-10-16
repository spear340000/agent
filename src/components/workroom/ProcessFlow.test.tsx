import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ProcessFlow from './ProcessFlow.js'
import type { Task } from './types.js'

const task = {
  id: 't1',
  legal: {
    intent: 'law',
    path: 'direct',
    answer: '',
    citations: [],
    sourceStatus: {
      corpusReady: true,
      retrieved: 1,
      degraded: [],
      currentness: 'unverified',
      notes: [],
      failures: [],
      ledger: {
        layers: [{ id: 'rag', label: 'RAG', state: 'used', detail: '' }],
        tools: [
          {
            tool: 'search_laws',
            label: '법령',
            query: '민법 750조',
            results: 1
          }
        ],
        toolCalls: 1,
        maxToolCalls: 12,
        planner: { calls: 0, mode: 'not-used' }
      }
    },
    plannerCalls: 0,
    toolCalls: 1
  },
  activity: [{ id: 'a1', title: '요청 분류', detail: '', at: 1 }]
} as unknown as Task

test('the flow renders its stages and the folded raw log without fetching the trace while closed', () => {
  const html = renderToStaticMarkup(
    createElement(ProcessFlow, {
      task,
      connection: { baseUrl: 'http://x', token: '' }
    })
  )
  assert.match(html, /처리 흐름/)
  assert.match(html, /질문 분류/)
  assert.match(html, /근거 검색/)
  assert.match(html, /원본 기록 1건/)
  assert.doesNotMatch(html, /처리 시간을 불러오는 중/)
  assert.doesNotMatch(html, /role="alert"/)
})
