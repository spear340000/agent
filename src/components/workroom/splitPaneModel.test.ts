import assert from 'node:assert/strict'
import test from 'node:test'
import { resizeContextPaneWidth } from './splitPaneModel.js'

test('resizes the task context by pointer delta and clamps usable bounds', () => {
  assert.equal(resizeContextPaneWidth(280, 84), 364)
  assert.equal(resizeContextPaneWidth(250, -80), 240)
  assert.equal(resizeContextPaneWidth(450, 80), 460)
})
