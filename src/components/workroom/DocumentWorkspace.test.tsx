import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DocumentOutline from './DocumentOutline.js'
import DocumentWorkspace from './DocumentWorkspace.js'
import type { DocumentWorkspaceProps } from './DocumentWorkspace.js'

function renderWorkspace(
  overrides: Partial<DocumentWorkspaceProps> = {}
): string {
  const props: DocumentWorkspaceProps = {
    title: '시장 분석 보고서',
    value: '# 시장 분석 보고서\n\n본문',
    hasPersistedDocument: true,
    dirty: false,
    saving: false,
    saveError: null,
    initialMode: 'edit',
    onChange: () => undefined,
    onSave: async () => undefined,
    onExport: () => undefined,
    ...overrides
  }
  return renderToStaticMarkup(createElement(DocumentWorkspace, props))
}

test('rendersSupportedToolbarAndSaveStates', () => {
  const markup = renderWorkspace()
  for (const label of ['제목 1', '제목 2', '굵게', '글머리 기호', '인용구']) {
    assert.match(markup, new RegExp(`aria-label="${label}"`))
  }
  assert.match(markup, /저장/)
  assert.match(markup, /Markdown/)
  assert.match(markup, /DOCX/)
  assert.match(markup, /저장됨/)
  assert.match(renderWorkspace({ dirty: true }), /저장되지 않음/)
  assert.match(renderWorkspace({ dirty: true, saving: true }), /저장 중/)
  assert.match(
    renderWorkspace({ dirty: true, saveError: '연결 오류' }),
    /저장 실패/
  )
  assert.match(
    renderWorkspace({ dirty: true, saveError: '연결 오류' }),
    /role="alert"/
  )
  assert.doesNotMatch(
    renderWorkspace({ hasPersistedDocument: false }),
    /저장됨/
  )
  assert.match(renderWorkspace({ dirty: true, canSave: false }), /disabled=""/)
})

test('the document opens in a rendered view instead of raw markdown', () => {
  const markup = renderWorkspace({
    initialMode: 'view',
    value: [
      '# 민법 제398조',
      '',
      '> 법률 자문이 아닙니다.',
      '',
      '## 답변',
      '',
      '**제398조 (배상액의 예정)**',
      '',
      '1. 손해배상액을 예정할 수 있습니다 [L1].',
      '2. 법원은 적당히 감액할 수 있습니다. [L1]',
      '',
      '### 사용한 검색 계층',
      '',
      '- 법령 키워드 검색: 이번 작업에서 사용 (81,445건 색인)',
      '',
      '| 항목 | 요약 | 근거 |',
      '| --- | --- | --- |',
      '| 책임 | 손해 발생 시 판단 | [P1] |',
      '',
      '공식 링크는 <https://www.law.go.kr/> 에 있습니다.'
    ].join('\n')
  })
  assert.match(markup, /class="markdown-view"/)
  assert.match(markup, /<h1[^>]*>민법 제398조<\/h1>/)
  assert.match(markup, /<blockquote>법률 자문이 아닙니다\.<\/blockquote>/)
  assert.match(markup, /<strong>제398조 \(배상액의 예정\)<\/strong>/)
  assert.match(markup, /<ol>/)
  assert.match(markup, /<cite class="md-citation"[^>]*>L1<\/cite>/)
  assert.match(markup, /<h3[^>]*>사용한 검색 계층<\/h3>/)
  assert.match(markup, /<div class="md-table-wrap" role="region" aria-label="문서 표" tabindex="0"><table>/)
  assert.match(markup, /<th scope="col">항목<\/th>/)
  assert.match(markup, /<td>책임<\/td>/)
  assert.match(markup, /<cite class="md-citation"[^>]*>P1<\/cite>/)
  assert.doesNotMatch(markup, /\| 항목 \| 요약 \| 근거 \|/)
  assert.match(markup, /href="https:\/\/www\.law\.go\.kr\/"/)
  assert.doesNotMatch(markup, /<textarea/)
  assert.doesNotMatch(markup, />## 답변</, 'raw markdown markers must not be shown as text')
})

test('omitsEmptyOutline', () => {
  const markup = renderToStaticMarkup(
    createElement(DocumentOutline, { headings: [], onSelect: () => undefined })
  )
  assert.equal(markup, '')
})
