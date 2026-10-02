import assert from 'node:assert/strict'
import test from 'node:test'
import { officeApi } from './automation'

const connection = { baseUrl: 'http://127.0.0.1:8787', token: '' }

test('file-library search and pagination are sent to the backend, including Unicode names', async () => {
  const original = globalThis.fetch
  let requested = ''
  globalThis.fetch = async (input) => {
    requested = String(input)
    return Response.json({ items: [], nextCursor: null })
  }
  try {
    await officeApi.listFiles(connection, 'file_previous', '회의록')
    const url = new URL(requested)
    assert.equal(url.pathname, '/api/files')
    assert.equal(url.searchParams.get('cursor'), 'file_previous')
    assert.equal(url.searchParams.get('search'), '회의록')
  } finally {
    globalThis.fetch = original
  }
})

test('computer automation sends the real action-envelope contract', async () => {
  const original = globalThis.fetch
  let body: unknown
  globalThis.fetch = async (_, init) => {
    body = JSON.parse(String(init?.body))
    return Response.json({
      kind: 'screenshot',
      executed: true,
      screenshotBase64: 'test'
    })
  }
  try {
    const result = await officeApi.computerAction(connection, {
      kind: 'screenshot'
    })
    assert.deepEqual(body, { action: { kind: 'screenshot' } })
    assert.equal(result.executed, true)
  } finally {
    globalThis.fetch = original
  }
})
