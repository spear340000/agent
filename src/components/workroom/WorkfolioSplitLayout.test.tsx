import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import WorkfolioSplitLayout from './WorkfolioSplitLayout.js'

test('renders the resize separator between chat context and document work area', () => {
  const markup = renderToStaticMarkup(
    createElement(WorkfolioSplitLayout, {
      context: createElement('aside', null, '대화 영역'),
      workArea: createElement('section', null, '문서 작업 영역')
    })
  )

  const contextPosition = markup.indexOf('대화 영역')
  const separatorPosition = markup.indexOf('role="separator"')
  const workAreaPosition = markup.indexOf('문서 작업 영역')

  assert.ok(contextPosition >= 0)
  assert.ok(separatorPosition > contextPosition)
  assert.ok(workAreaPosition > separatorPosition)
  assert.match(markup, /aria-label="대화 영역 너비 조절"/)
  assert.match(markup, /aria-orientation="vertical"/)
  assert.match(markup, /aria-valuemin="240"/)
  assert.match(markup, /aria-valuemax="460"/)
  assert.match(markup, /aria-valuenow="280"/)
})

test('keeps the resize separator available when the context drawer is open', () => {
  const markup = renderToStaticMarkup(
    createElement(WorkfolioSplitLayout, {
      context: createElement('aside', null, '대화 영역'),
      workArea: createElement('section', null, '문서 작업 영역'),
      contextDrawerOpen: true
    })
  )

  assert.match(markup, /workfolio-active-layout--context-open/)
})
