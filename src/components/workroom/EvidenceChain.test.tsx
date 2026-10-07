import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import EvidenceChain, { RouteChips, routeLayers } from './EvidenceChain.js'
import { chainFrom } from './taskAdapters.js'

const graphRoute = [
  '관계 그래프: 판례 「손해배상」 —citesArticle→ 민법 제398조 (온톨로지가 허용한 관계) → MCP get_precedent로 판례 원문의 참조조문에서 인용 확인',
  'OKF 카탈로그: Legal Corpus — Precedents (../../data/legal/precedent)'
]

test('a recorded route becomes the ordered list of layers the record passed through', () => {
  assert.deepEqual(routeLayers(graphRoute), ['그래프', '온톨로지', 'MCP', 'OKF'])
  assert.deepEqual(
    routeLayers([
      'RAG 검색(키워드 + 벡터) · MCP search_laws',
      'LLM Wiki 핵심 조문집 \'해고 등의 제한\' → MCP get_law_article로 원문 확인'
    ]),
    ['RAG', 'MCP', 'Wiki']
  )
  assert.deepEqual(routeLayers(undefined), [])
  const chips = renderToStaticMarkup(createElement(RouteChips, { provenance: graphRoute }))
  assert.match(chips, /그래프[\s\S]*온톨로지[\s\S]*MCP[\s\S]*OKF/)
  assert.equal(renderToStaticMarkup(createElement(RouteChips, { provenance: [] })), '')
})

test('the evidence chain is parsed defensively and rendered as ordered steps', () => {
  const stages = chainFrom([
    { id: 'rag', label: 'RAG 검색 (키워드 + 벡터)', summary: '법령 2건', items: ['법령 검색: 위약금'] },
    { id: 'graph', label: '관계 그래프', summary: '인용 판례 1건 추가', items: ['83다카1442 —인용→ 민법 제398조'] },
    { id: 'from-the-future', label: 'x', summary: 'y', items: [] },
    'not a stage'
  ])
  assert.deepEqual(stages.map((stage) => stage.id), ['rag', 'graph'], 'unknown stage ids are skipped')
  assert.deepEqual(chainFrom(undefined), [])
  const markup = renderToStaticMarkup(createElement(EvidenceChain, { stages }))
  assert.match(markup, /근거 형성 과정/)
  assert.match(markup, /RAG 검색 \(키워드 \+ 벡터\)[\s\S]*관계 그래프/)
  assert.match(markup, /83다카1442/)
  assert.equal(renderToStaticMarkup(createElement(EvidenceChain, { stages: [] })), '')
})
