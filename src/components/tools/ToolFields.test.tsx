import React from 'react'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ComputerTools from './ComputerTools'

test('disabled native automation does not pretend that an operation is running', () => {
  const markup = renderToStaticMarkup(
    <ComputerTools
      connection={{ baseUrl: 'http://127.0.0.1:8787', token: '' }}
      files={[]}
      busy={false}
      available={false}
      run={async () => undefined}
    />
  )
  assert.match(markup, /현재 비활성화/)
  assert.match(markup, /disabled=""/)
  assert.match(markup, /화면 캡처<\/button>/)
  assert.doesNotMatch(markup, /처리 중/)
})
