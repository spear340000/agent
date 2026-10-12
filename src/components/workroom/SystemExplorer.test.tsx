import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaultConnection } from '@/api/workroom'
import SystemExplorer from './SystemExplorer.js'
import type { Task } from './types.js'

const task: Task = {
  id: 'task-1',
  title: '민법 검토',
  request: '민법 제750조와 판례의 관계를 정리해줘',
  sources: [],
  messages: [],
  steps: [
    { id: 'plan', title: '요청 정리', status: 'completed', progress: 100 },
    { id: 'collect', title: '자료 수집', status: 'completed', progress: 100 },
    { id: 'write', title: '문서 작성', status: 'running', progress: 45 }
  ],
  stage: 'writing',
  state: 'running',
  document: '',
  documentType: 'md',
  createdAt: 1,
  updatedAt: 2,
  legal: {
    intent: 'legal-research',
    path: 'orchestrated',
    answer: '',
    plannerCalls: 1,
    toolCalls: 1,
    citations: [],
    sourceStatus: {
      corpusReady: true,
      retrieved: 2,
      cited: 0,
      degraded: [],
      currentness: 'unverified',
      notes: [],
      failures: [],
      ledger: {
        layers: [],
        toolCalls: 1,
        maxToolCalls: 5,
        planner: { calls: 1, mode: 'used' },
        tools: [
          {
            tool: 'search_all',
            label: '법령·판례 통합 검색',
            query: '민법 제750조와 판례의 관계를 정리해줘',
            results: 2
          }
        ]
      }
    }
  }
}

test('agentic flow is rendered as a connected execution canvas using actual task and RAG traces', () => {
  const markup = renderToStaticMarkup(
    createElement(SystemExplorer, {
      capabilities: null,
      backendStatus: 'online',
      onRetry: () => {},
      connection: defaultConnection,
      tasks: [task],
      topic: 'flow',
      onTopicChange: () => {}
    })
  )
  assert.match(markup, /system-flow__canvas/)
  assert.match(markup, /사용자 요청/)
  assert.match(markup, /민법 제750조와 판례의 관계를 정리해줘/)
  assert.match(markup, /요청 정리/)
  assert.doesNotMatch(markup, /조사 계획 수립/)
  assert.match(markup, /법령·판례 통합 검색/)
  assert.match(markup, /민법 제750조와 판례의 관계를 정리해줘/)
  assert.match(markup, /system-flow__connector/)
  assert.doesNotMatch(markup, /system-explorer__run-steps/)
})

test('execution flow preserves file-before-plan legal ordering and document research ordering', () => {
  for (const titles of [
    [
      'Plan task',
      'Read source files',
      'Research the web',
      'Analyze evidence',
      'Generate cited DOCX'
    ],
    [
      '첨부 자료 확인',
      '검색 계획 수립',
      '제한된 근거 수집',
      '근거 검증',
      '근거 기반 답변 작성'
    ]
  ]) {
    const markup = renderToStaticMarkup(
      createElement(SystemExplorer, {
        capabilities: null,
        backendStatus: 'online',
        onRetry: () => {},
        connection: defaultConnection,
        topic: 'flow',
        onTopicChange: () => {},
        tasks: [
          {
            ...task,
            steps: titles.map((title, index) => ({
              id: String(index),
              title,
              status: 'completed' as const,
              progress: 100
            }))
          }
        ]
      })
    )
    const positions = titles.map((title) => markup.indexOf(title))
    assert.ok(positions.every((position) => position >= 0))
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b)
    )
    assert.doesNotMatch(markup, /조사 계획 수립/)
    assert.ok(
      markup.indexOf('aria-label="실제 검색 도구 호출"') > positions.at(-1)!
    )
  }
})

test('site flow describes combined source inputs and conditional legal planning', () => {
  const markup = renderToStaticMarkup(
    createElement(SystemExplorer, {
      capabilities: null,
      backendStatus: 'online',
      onRetry: () => {},
      connection: defaultConnection,
      tasks: [],
      topic: 'site-flow',
      onTopicChange: () => {}
    })
  )
  assert.match(markup, /일반 문서 요청/)
  assert.match(markup, /한 작업에 함께 포함/)
  assert.match(markup, /직접 조회 또는 복합 조사 계획/)
  assert.match(markup, /검색 결과 페이지도 방문/)
  assert.ok(
    markup.indexOf('첨부 자료 확인') <
      markup.indexOf('직접 조회 또는 복합 조사 계획')
  )
})

test('LLM Wiki exposes a read-only source-page browser alongside indexed legal search', () => {
  const markup = renderToStaticMarkup(
    createElement(SystemExplorer, {
      capabilities: null,
      backendStatus: 'online',
      onRetry: () => {},
      connection: defaultConnection,
      tasks: [task],
      topic: 'wiki',
      onTopicChange: () => {}
    })
  )
  assert.match(markup, /읽기 전용 Wiki 문서/)
  assert.match(markup, /Wiki 문서 필터/)
  assert.match(markup, /Wiki 원문/)
  assert.match(
    markup,
    /목록에서 Wiki 페이지를 선택하면 원문을 읽기 전용으로 표시합니다/
  )
  assert.match(markup, /색인 검색/)
})
