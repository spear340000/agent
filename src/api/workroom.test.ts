import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTask,
  backendUrl,
  getFileContent,
  checkConnection,
  searchLegalLibrary,
  listLegalWikiPages,
  getLegalWikiPage,
  fetchFileContent,
  reviseTask,
  request,
  watchTask,
  type Connection,
  type TaskDetails
} from './workroom.js'

test('fetchFileContent retrieves the actual PDF bytes using the saved API token', async () => {
  const connection: Connection = {
    baseUrl: 'http://127.0.0.1:8787',
    token: ' test-token '
  }
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  const file = await fetchFileContent(
    'folder/file-123',
    connection,
    async (url, init) => {
      requestUrl = String(url)
      requestInit = init
      return new Response('%PDF-1.7\nreal bytes', {
        headers: { 'content-type': 'application/pdf' }
      })
    }
  )

  assert.equal(
    requestUrl,
    'http://127.0.0.1:8787/api/files/folder%2Ffile-123/content'
  )
  assert.equal(
    new Headers(requestInit?.headers).get('authorization'),
    'Bearer test-token'
  )
  assert.equal(requestInit?.cache, 'no-store')
  assert.equal(file.type, 'application/pdf')
  assert.equal(await file.text(), '%PDF-1.7\nreal bytes')
})

test('fetchFileContent reports an unavailable source file instead of returning an empty preview', async () => {
  await assert.rejects(
    fetchFileContent(
      'file-missing',
      { baseUrl: 'http://127.0.0.1:8787', token: '' },
      async () => new Response('not found', { status: 404 })
    ),
    /파일 내용을 불러오지 못했습니다\. \(404\)/
  )
})

test('plain HTTP backend URLs are accepted', () => {
  assert.equal(
    backendUrl({ baseUrl: 'http://localhost:8787', token: 'local' }, '/api'),
    'http://localhost:8787/api'
  )
  assert.equal(
    backendUrl({ baseUrl: 'http://127.0.0.1:8787', token: '' }, '/api'),
    'http://127.0.0.1:8787/api'
  )
  assert.equal(
    backendUrl({ baseUrl: 'https://api.example.com', token: 'secret' }, '/api'),
    'https://api.example.com/api'
  )
  assert.equal(
    backendUrl({ baseUrl: 'http://api.example.com', token: 'secret' }, '/api'),
    'http://api.example.com/api'
  )
})

test('file downloads abort after their configured timeout', async () => {
  const connection: Connection = { baseUrl: 'http://127.0.0.1:8787', token: '' }
  await assert.rejects(
    getFileContent(
      'file_1',
      connection,
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) reject(new Error('aborted'))
          else
            signal?.addEventListener('abort', () =>
              reject(new Error('aborted'))
            )
        }),
      5
    ),
    /시간이 초과/
  )
})

test('read-only Wiki browser lists source pages and requests bounded original-text ranges', async () => {
  const connection: Connection = { baseUrl: 'http://127.0.0.1:8787', token: '' }
  const list = await listLegalWikiPages(connection, async (url) => {
    assert.equal(String(url), 'http://127.0.0.1:8787/api/legal/wiki')
    return Response.json({
      items: [
        { name: 'privacy-law-core.md', title: 'privacy law core', bytes: 1024 }
      ]
    })
  })
  assert.equal(list.items[0]?.name, 'privacy-law-core.md')
  assert.equal(list.items[0]?.bytes, 1024)

  const page = await getLegalWikiPage(
    'privacy-law-core.md',
    12000,
    8000,
    connection,
    async (url) => {
      const parsed = new URL(String(url))
      assert.equal(parsed.pathname, '/api/legal/wiki/page')
      assert.equal(parsed.searchParams.get('name'), 'privacy-law-core.md')
      assert.equal(parsed.searchParams.get('offset'), '12000')
      assert.equal(parsed.searchParams.get('limit'), '8000')
      return Response.json({
        name: 'privacy-law-core.md',
        content: '본문 구간',
        offset: 12000,
        nextOffset: 12005,
        totalCharacters: 20000,
        hasMore: true
      })
    }
  )
  assert.equal(page.content, '본문 구간')
  assert.equal(page.nextOffset, 12005)
  assert.equal(page.hasMore, true)
})

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
        items: [
          {
            citationId: 'G1',
            kind: 'graph',
            corpus: 'graph',
            recordId: 'case:1:CITES_ARTICLE:article:750',
            title: '판례 —CITES_ARTICLE→ 민법 제750조',
            excerpt: '관계 출처',
            graphRelation: {
              sourceId: 'case:1',
              sourceLabel: '판례',
              sourceType: 'Precedent',
              relation: 'CITES_ARTICLE',
              targetId: 'article:750',
              targetLabel: '민법 제750조',
              targetType: 'Article',
              sourcePath: 'case.md'
            }
          }
        ]
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

test('capability probes allow the cold legal-index status check to finish', async () => {
  const originalTimeout = AbortSignal.timeout
  const observedTimeouts: number[] = []
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: (milliseconds: number) => {
      observedTimeouts.push(milliseconds)
      return originalTimeout(60_000)
    }
  })
  try {
    await request(
      { baseUrl: 'http://127.0.0.1:8787', token: '' },
      '/api/capabilities',
      {},
      async () => Response.json({ legalRetrieval: { state: 'ready' } })
    )
    assert.deepEqual(observedTimeouts, [45_000])
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: originalTimeout
    })
  }
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
