import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaultConnection } from '@/api/workroom'
import type { RuntimeCapabilities } from '@/api/workroom'
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
  assert.match(markup, /조사 계획 수립/)
  assert.match(markup, /법령·판례 통합 검색/)
  assert.match(markup, /민법 제750조와 판례의 관계를 정리해줘/)
  assert.match(markup, /system-flow__connector/)
  assert.doesNotMatch(markup, /system-explorer__run-steps/)
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

test('overview shows the provider and model in use, and the model that answered the latest task', () => {
  const capabilities = {
    model: {
      configured: true,
      provider: 'openai-compatible',
      name: 'openai/gpt-oss-120b',
      providers: ['Groq', 'NVIDIA', 'OpenAI']
    }
  } as RuntimeCapabilities
  const answered = {
    ...task,
    id: 'answered',
    updatedAt: 99,
    modelUse: {
      finalModel: 'Groq · qwen/qwen3.8-27b',
      fellBack: true,
      failedModels: ['Groq · openai/gpt-oss-120b']
    }
  }
  const stale = {
    ...task,
    id: 'stale',
    updatedAt: 1,
    modelUse: { finalModel: 'NVIDIA · old', fellBack: false, failedModels: [] }
  }
  const render = (tasks: Task[]) =>
    renderToStaticMarkup(
      createElement(SystemExplorer, {
        capabilities,
        backendStatus: 'online',
        onRetry: () => {},
        connection: defaultConnection,
        tasks,
        topic: 'overview',
        onTopicChange: () => {}
      })
    )
  const markup = render([stale, answered])
  assert.match(markup, /Groq · [\s\S]*openai\/gpt-oss-120b/)
  assert.match(markup, /최근 작업 실제 응답: Groq · qwen\/qwen3\.8-27b/)
  assert.doesNotMatch(
    markup,
    /Groq → NVIDIA/,
    'the fallback chain is not shown'
  )
  assert.doesNotMatch(
    markup,
    /NVIDIA · old/,
    'only the most recently updated task counts'
  )
  assert.doesNotMatch(render([]), /최근 작업 실제 응답/)
})

test("the overview shows the order the components work in, and the flow tab shows this task's chain", () => {
  const render = (topic: 'overview' | 'flow', tasks: Task[]) =>
    renderToStaticMarkup(
      createElement(SystemExplorer, {
        capabilities: null,
        backendStatus: 'online',
        onRetry: () => {},
        connection: defaultConnection,
        tasks,
        topic,
        onTopicChange: () => {}
      })
    )
  const overview = render('overview', [])
  assert.match(overview, /질문 하나가 지나가는 순서/)
  assert.match(
    overview,
    /RAG 검색[\s\S]*LLM Wiki[\s\S]*에이전트[\s\S]*관계 그래프[\s\S]*온톨로지[\s\S]*MCP 도구[\s\S]*OKF[\s\S]*답변 검증/
  )

  const chained: Task = {
    ...task,
    legal: {
      ...task.legal!,
      sourceStatus: {
        ...task.legal!.sourceStatus,
        chain: [
          {
            id: 'rag',
            label: 'RAG 검색 (키워드 + 벡터)',
            summary: '법령 2건',
            items: []
          },
          {
            id: 'graph',
            label: '관계 그래프',
            summary: '인용 판례 1건 추가',
            items: ['83다카1442 —인용→ 민법 제398조']
          }
        ]
      }
    }
  }
  const flow = render('flow', [chained])
  assert.match(flow, /이 작업에서 지식 계층이 이어진 순서/)
  assert.match(flow, /관계 그래프[\s\S]*인용 판례 1건 추가/)
  assert.doesNotMatch(
    render('flow', [task]),
    /이 작업에서 지식 계층이 이어진 순서/,
    'no chain, no section'
  )
})
