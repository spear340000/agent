import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_BATCH_UPLOAD_BYTES,
  MAX_BATCH_UPLOAD_FILES,
  validateUploadBatch
} from './uploadBatch'

function file(name: string, size: number) {
  return { name, size, type: 'text/plain' }
}

test('batch uploads enforce both file count and aggregate size limits', () => {
  assert.doesNotThrow(() =>
    validateUploadBatch([
      file('one.txt', 10 * 1024 * 1024),
      file('two.txt', 10 * 1024 * 1024)
    ])
  )
  assert.throws(() =>
    validateUploadBatch(
      Array.from({ length: MAX_BATCH_UPLOAD_FILES + 1 }, (_, index) =>
        file(`${index}.txt`, 1)
      )
    )
  )
  assert.throws(() =>
    validateUploadBatch([
      file('one.txt', 9 * 1024 * 1024),
      file('two.txt', 9 * 1024 * 1024),
      file('three.txt', 8 * 1024 * 1024)
    ])
  )
  assert.equal(MAX_BATCH_UPLOAD_BYTES, 25 * 1024 * 1024)
})
