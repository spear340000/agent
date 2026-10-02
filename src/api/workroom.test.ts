import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTask,
  checkConnection,
  searchLegalLibrary,
  reviseTask,
  watchTask,
  type Connection,
  type TaskDetails
} from './workroom.js'

test('legal library displays backend corpus records and passes the chosen query unchanged', async () => {
  let requestUrl = ''
  const result = await searchLegalLibrary(
    '  민법 제750조  ',
    'law',
    { baseUrl: 'http://127.0.0.1:8787', token: '' },
    20,
    async (url) => {
      requestUrl = String(url)
      return Response.json({
        query: '  민법 제750조  ',
        corpus: 'law',
        items: [
          {
            citationId: 'L1',
            kind: 'law',
            corpus: 'law',
            recordId: 'law-1',
            title: '민법',
            excerpt: '원문 일부'
          }
        ]
      })
    }
  )

  const parsed = new URL(requestUrl)
  assert.equal(parsed.pathname, '/api/legal/library')
  assert.equal(parsed.searchParams.get('q'), '  민법 제750조  ')
  assert.equal(parsed.searchParams.get('corpus'), 'law')
  assert.equal(parsed.searchParams.get('limit'), '20')
  assert.equal(result.items[0]?.title, '민법')
})

test('graph library requests the expanded bounded edge set and preserves typed relationship evidence', async () => {
  let requestUrl = ''
  const result = await searchLegalLibrary(
    '민법 제750조',
    'graph',
    { baseUrl: 'http://127.0.0.1:8787', token: '' },
    undefined,
    async (url) => {
      requestUrl = String(url)
      return Response.json({
        query: '민법 제750조',
        corpus: 'graph',
        items: [{
          citationId: 'G1', kind: 'graph', corpus: 'graph', recordId: 'case:1:CITES_ARTICLE:article:750',
          title: '판례 —CITES_ARTICLE→ 민법 제750조', excerpt: '관계 출처',
          graphRelation: { sourceId: 'case:1', sourceLabel: '판례', sourceType: 'Precedent', relation: 'CITES_ARTICLE', targetId: 'article:750', targetLabel: '민법 제750조', targetType: 'Article', sourcePath: 'case.md' }
        }]
      })
    }
  )
  assert.equal(new URL(requestUrl).searchParams.get('q'), '민법 제750조')
  assert.equal(new URL(requestUrl).searchParams.get('limit'), '30')
  assert.equal(result.items[0]?.graphRelation?.relation, 'CITES_ARTICLE')
  assert.equal(result.items[0]?.graphRelation?.sourcePath, 'case.md')
})

test('cancelled connection checks do not continue into capability requests', async () => {
  const controller = new AbortController()
  controller.abort(new Error('connection check cancelled'))
  let calls = 0
  const checking = checkConnection(
    { baseUrl: 'http://127.0.0.1:8787', token: '' },
    async (_url, init) => {
      calls += 1
      if (init?.signal?.aborted) throw init.signal.reason
      return Response.json({ ok: true })
    },
    controller.signal
  )
  await assert.rejects(() => checking, /connection check cancelled/)
  assert.equal(calls, 1)
})

test('createTask sends source ids and URLs to the real backend task endpoint', async () => {
  const connection: Connection = {
    baseUrl: 'http://127.0.0.1:8787',
    token: ''
  }
  const backendTask = {
    id: 'task_123',
    title: '요청 요약',
    prompt: '요청 요약',
    sourceFileIds: ['file_123'],
    sourceUrls: ['https://example.com/source'],
    status: 'queued',
    steps: [],
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z'
  }
  let requestUrl = ''
  let requestBody = ''
  const result = await createTask(
    connection,
    '요청 요약',
    ['file_123'],
    ['https://example.com/source'],
    async (input, init) => {
      requestUrl = String(input)
      requestBody = String(init?.body)
      return new Response(JSON.stringify({ task: backendTask }), {
        status: 202,
        headers: { 'content-type': 'application/json' }
      })
    }
  )

  assert.equal(requestUrl, 'http://127.0.0.1:8787/api/tasks')
  assert.deepEqual(JSON.parse(requestBody), {
    prompt: '요청 요약',
    sourceFileIds: ['file_123'],
    sourceUrls: ['https://example.com/source']
  })
  assert.equal(result.task.id, 'task_123')
})

test('follow-up uploads are included in the revision payload', async () => {
  const details: TaskDetails = {
    task: {
      id: 'task_1',
      title: '문서',
      prompt: '요청',
      sourceFileIds: [],
      sourceUrls: [],
      status: 'queued',
      steps: [],
      createdAt: '',
      updatedAt: ''
    },
    events: [],
    artifacts: []
  }
  let payload: unknown
  await reviseTask(
    'task_1',
    'followup',
    '새 자료도 반영해',
    { baseUrl: 'http://127.0.0.1:8787', token: '' },
    async (_url, init) => {
      if (init?.method === 'POST') payload = JSON.parse(String(init.body))
      return Response.json(
        init?.method === 'POST' ? { task: details.task } : details
      )
    },
    { sourceFileIds: ['file_new'], sourceUrls: ['https://example.com/'] }
  )
  assert.deepEqual(payload, {
    kind: 'followup',
    message: '새 자료도 반영해',
    sourceFileIds: ['file_new'],
    sourceUrls: ['https://example.com/']
  })
})

test('stream EOF reconnects with its event cursor and reaches a terminal task', async () => {
  const details: TaskDetails = {
    task: {
      id: 'task_1',
      title: '문서',
      prompt: '요청',
      sourceFileIds: [],
      sourceUrls: [],
      status: 'running',
      steps: [],
      createdAt: '',
      updatedAt: ''
    },
    events: [],
    artifacts: []
  }
  let streams = 0
  let cursor: string | null = null
  const updates: string[] = []
  await watchTask(
    'task_1',
    (value) => updates.push(value.task.status),
    new AbortController().signal,
    { baseUrl: 'http://127.0.0.1:8787', token: '' },
    async (url, init) => {
      if (String(url).endsWith('/events')) {
        streams++
        if (streams === 2)
          cursor = new Headers(init?.headers).get('last-event-id')
        return new Response(
          `id: ${streams + 6}\ndata: {"id":${streams + 6},"type":"step.completed"}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
      return Response.json({
        ...details,
        task: {
          ...details.task,
          status: streams >= 2 ? 'completed' : 'running'
        }
      })
    },
    { retryDelayMs: 1 }
  )
  assert.equal(streams, 2)
  assert.equal(cursor, '7')
  assert.equal(updates.at(-1), 'completed')
})

test('watchTask refreshes backend task details from a streamed event', async () => {
  const connection: Connection = {
    baseUrl: 'http://127.0.0.1:8787',
    token: ''
  }
  const taskDetails: TaskDetails = {
    task: {
      id: 'task_123',
      title: '완료된 문서',
      prompt: '문서를 작성해 주세요.',
      sourceFileIds: [],
      sourceUrls: [],
      status: 'completed',
      steps: [],
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:01:00.000Z'
    },
    events: [],
    artifacts: []
  }
  const encoder = new TextEncoder()
  let streamedResponse = false
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith('/events')) {
      streamedResponse = true
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('id: 1\ndata: {"id":1,"type":'))
            controller.enqueue(encoder.encode('"task.completed"}\n\n'))
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
    return new Response(JSON.stringify(taskDetails), {
      headers: { 'content-type': 'application/json' }
    })
  }
  const controller = new AbortController()
  let received: TaskDetails | undefined

  await watchTask(
    'task_123',
    (details) => {
      received = details
    },
    controller.signal,
    connection,
    fetcher
  )

  assert.equal(streamedResponse, true)
  assert.equal(received?.task.status, 'completed')
})
