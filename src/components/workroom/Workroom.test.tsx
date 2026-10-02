import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Workroom from './Workroom.js'

test('renders the Workfolio shell and truthful initial connection status', () => {
  const markup = renderToStaticMarkup(createElement(Workroom))

  assert.match(markup, /Workfolio/)
  assert.match(markup, /백엔드 확인 중/)
  assert.match(markup, /백엔드와 작업 목록을 확인하고 있습니다\./)
  assert.match(markup, /aria-label="백엔드 연결 설정"/)
  assert.match(markup, /aria-label="문서 도구 열기"/)
  assert.doesNotMatch(markup, /작업 검색|계정 메뉴|DocumentConstellation/)
})
