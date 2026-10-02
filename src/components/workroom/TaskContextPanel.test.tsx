import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TaskContextPanel from './TaskContextPanel.js'
import type { Task } from './types.js'

function createTask(state: Task['state']): Task {
  return {
    id: 'task-real-1',
    title: '분기 매출 분석',
    request: '첨부한 실적 자료를 비교하고 변동 원인을 요약해 주세요.',
    sources: [
      { id: 'file-1', name: '1분기 실적.xlsx', kind: 'file' },
      {
        id: 'link-1',
        name: '공시 자료',
        kind: 'link',
        url: 'https://example.com/report'
      }
    ],
    messages: [
      {
        id: 'message-1',
        kind: 'followup',
        text: '지역별 표도 추가해 주세요.',
        createdAt: 1
      }
    ],
    stage: state === 'running' || state === 'failed' ? 'analyzing' : 'planning',
    steps: [],
    state,
    document: '',
    documentType: 'md',
    createdAt: 1,
    updatedAt: 2,
    ...(state === 'failed'
      ? { error: '자료 분석 단계에서 연결이 끊겼습니다.' }
      : {})
  }
}

function renderPanel(state: Task['state']): string {
  return renderToStaticMarkup(
    createElement(TaskContextPanel, {
      task: createTask(state),
      mobileOpen: false,
      onMobileOpenChange: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onFollowup: async () => true
    })
  )
}

test('showsActionsForActionableTaskStates', () => {
  for (const state of ['queued', 'running'] as const) {
    assert.match(renderPanel(state), /작업 취소/)
  }
  assert.match(renderPanel('failed'), /다시 실행/)
  assert.doesNotMatch(renderPanel('completed'), /작업 취소|다시 실행/)
  for (const state of [
    'queued',
    'running',
    'failed',
    'completed',
    'cancelled'
  ] as const) {
    const markup = renderPanel(state)
    assert.match(markup, /작업 진행 상황/)
    assert.doesNotMatch(markup, /\b\d{1,3}%/)
  }
  assert.match(renderPanel('failed'), /자료 분석 단계에서 연결이 끊겼습니다\./)
})

test('rendersTaskRequestAndSources', () => {
  const markup = renderPanel('completed')
  assert.match(
    markup,
    /첨부한 실적 자료를 비교하고 변동 원인을 요약해 주세요\./
  )
  assert.match(markup, /1분기 실적\.xlsx/)
  assert.match(markup, /https:\/\/example\.com\/report/)
  assert.match(markup, /지역별 표도 추가해 주세요\./)
  assert.match(markup, /문서 수정/)
  assert.match(markup, /추가 요청/)
  assert.match(markup, /파일 추가/)
  assert.match(markup, /링크 추가/)
})

test('renders user requests as bubbles without styling assistant content', () => {
  const markup = renderPanel('completed')
  const userBubbleCount = [
    ...markup.matchAll(
      /class="task-context__message task-context__message--user"/g
    )
  ].length

  assert.equal(userBubbleCount, 2)
  assert.doesNotMatch(markup, /task-context__message--assistant/)
})

test('shows the steps that actually ran instead of a fixed stage list', () => {
  const markup = renderToStaticMarkup(
    createElement(TaskContextPanel, {
      task: {
        ...createTask('completed'),
        steps: [
          {
            id: 'step_1',
            title: '법령·판례 근거 확인',
            status: 'completed',
            progress: 100
          },
          {
            id: 'step_2',
            title: '근거 기반 답변 작성',
            status: 'completed',
            progress: 100
          }
        ]
      },
      mobileOpen: false,
      onMobileOpenChange: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onFollowup: async () => true
    })
  )
  assert.match(markup, /법령·판례 근거 확인/)
  assert.match(markup, /근거 기반 답변 작성/)
  assert.doesNotMatch(markup, /자료 분석/)
})

test('renders legal citations, currentness, and the draft action', () => {
  let drafted = 0
  const markup = renderToStaticMarkup(
    createElement(TaskContextPanel, {
      task: {
        ...createTask('completed'),
        legal: {
          intent: 'article-lookup',
          path: 'direct',
          answer: '조문은 손해배상액의 예정이 가능합니다 [L1].',
          citations: [
            {
              citationId: 'L1',
              recordId: 'law:민법#제398조',
              corpus: 'law',
              label: '민법 제398조 (배상액의 예정)',
              officialUrl: 'https://www.law.go.kr/',
              date: { kind: 'amendment', value: '2010.1.22' }
            }
          ],
          sourceStatus: {
            corpusReady: true,
            retrieved: 1,
            degraded: ['vector'],
            currentness: 'record-dated',
            notes: ['벡터 검색을 사용하지 못해 키워드·그래프 검색 결과만 사용했습니다.'],
            failures: []
          },
          plannerCalls: 0,
          toolCalls: 1
        }
      },
      mobileOpen: false,
      onMobileOpenChange: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onFollowup: async () => true,
      onDraftFromAnswer: () => {
        drafted += 1
      }
    })
  )
  assert.match(markup, /조문 확인/)
  assert.match(markup, /직접 조회/)
  assert.match(markup, /\[L1\]/)
  assert.match(markup, /민법 제398조 \(배상액의 예정\)/)
  assert.match(markup, /https:\/\/www\.law\.go\.kr\//)
  assert.match(markup, /개정 표기 2010\.1\.22/)
  assert.match(markup, /법률 자문이나 대리인이 아닙니다/)
  assert.match(markup, /답변을 법률 문서 초안으로 정리/)
  assert.equal(drafted, 0)
})

test('states plainly when no legal record was confirmed', () => {
  const markup = renderToStaticMarkup(
    createElement(TaskContextPanel, {
      task: {
        ...createTask('completed'),
        legal: {
          intent: 'legal-question',
          path: 'direct',
          answer: '확인된 기록이 없습니다.',
          citations: [],
          sourceStatus: {
            corpusReady: true,
            retrieved: 0,
            degraded: ['vector'],
            currentness: 'unverified',
            notes: [],
            failures: []
          },
          plannerCalls: 0,
          toolCalls: 1
        }
      },
      mobileOpen: false,
      onMobileOpenChange: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onFollowup: async () => true
    })
  )
  assert.match(markup, /확인된 법령·판례 기록이 없어/)
  assert.match(markup, /색인이 현행 여부를 확인하지 않음/)
})

test('the technology ledger shows which retrieval layers actually ran', () => {
  const markup = renderToStaticMarkup(
    createElement(TaskContextPanel, {
      task: {
        ...createTask('completed'),
        legal: {
          intent: 'legal-question',
          path: 'direct',
          answer: '답변 [L1]',
          citations: [
            {
              citationId: 'L1',
              recordId: 'law:민법#제398조',
              corpus: 'law',
              label: '민법 제398조'
            }
          ],
          sourceStatus: {
            corpusReady: true,
            retrieved: 1,
            cited: 1,
            degraded: ['vector'],
            currentness: 'record-dated',
            notes: [],
            failures: [],
            ledger: {
              layers: [
                {
                  id: 'law-keyword',
                  label: '법령 키워드 검색',
                  state: 'used',
                  detail: '81,445건 색인 · 이 작업에서 조회함'
                },
                {
                  id: 'precedent-keyword',
                  label: '판례 키워드 검색',
                  state: 'used',
                  detail: '124,925건 색인 · 이 작업에서 조회함'
                },
                {
                  id: 'vector',
                  label: '벡터 유사도 검색',
                  state: 'unused',
                  detail: '사용하지 않음 · disabled by USE_QDRANT=false'
                },
                {
                  id: 'graph',
                  label: '법령 관계 그래프',
                  state: 'ready',
                  detail: '노드 429,245 · 이번 작업에서는 조회하지 않음'
                },
                {
                  id: 'ontology',
                  label: '법률 온톨로지',
                  state: 'ready',
                  detail: 'RDF 온톨로지 검증 통과'
                },
                {
                  id: 'okf',
                  label: 'OKF 상태 번들',
                  state: 'ready',
                  detail: '출처·상태 번들 검증 통과'
                }
              ],
              tools: [
                {
                  tool: 'search_laws',
                  label: '법령 검색',
                  query: '손해배상 예정',
                  results: 5
                }
              ],
              toolCalls: 2,
              maxToolCalls: 12,
              planner: { calls: 0, mode: 'not-used' }
            }
          },
          plannerCalls: 0,
          toolCalls: 2
        }
      },
      mobileOpen: false,
      onMobileOpenChange: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onFollowup: async () => true
    })
  )
  assert.match(markup, /검색 기술 사용 현황/)
  assert.match(markup, /법령 키워드 검색/)
  assert.match(markup, /이번 작업에서 사용/)
  assert.match(markup, /벡터 유사도 검색/)
  assert.match(markup, /사용하지 않음/)
  assert.match(markup, /법령 관계 그래프/)
  assert.match(markup, /이번 작업에서는 조회하지 않음/)
  assert.match(markup, /법률 온톨로지/)
  assert.match(markup, /OKF 상태 번들/)
  assert.match(markup, /search_laws/)
  assert.match(markup, /기록 5건/)
  assert.match(markup, /도구 호출 2회 \/ 한도 12회/)
  assert.match(
    markup,
    /계획 모델 미사용 · 결정적 라우팅으로 직접 조회/,
    'the planner must be shown as unused rather than implied'
  )
})