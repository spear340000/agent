import assert from 'node:assert/strict'
import test from 'node:test'
import { readWorkbook } from './DocumentFormatPreview.js'

test('rejects oversized workbooks before allocating or parsing their contents', async () => {
  const oversized = new Blob([])
  Object.defineProperty(oversized, 'size', {
    value: 20 * 1024 * 1024 + 1
  })

  await assert.rejects(readWorkbook(oversized), /너무 큽니다/)
})
