import assert from 'node:assert/strict'
import test from 'node:test'
import { SearxngSearchProvider } from '../src/infrastructure/search/searxng-search-provider.js'

test('normalizes, bounds, and de-duplicates SearXNG JSON results', async () => {
  let requestedUrl: URL | undefined
  let requestOptions: RequestInit | undefined
  const provider = new SearxngSearchProvider({
    baseUrl: 'http://127.0.0.1:8888/',
    fetcher: async (input, init) => {
      requestedUrl = new URL(String(input))
      requestOptions = init
      return new Response(JSON.stringify({
        results: [
          { title: ' First result ', url: 'https://example.com/first#part', content: ' A useful snippet ' },
          { title: 'Duplicate', url: 'https://example.com/first', content: 'duplicate' },
          { title: 'Second result', url: 'https://example.org/second', content: 'Second snippet' },
          { title: 'Unsafe scheme', url: 'javascript:alert(1)', content: 'ignore' },
          { title: '', url: 'https://example.net/empty', content: 'ignore' }
        ]
      }), { headers: { 'content-type': 'application/json' } })
    }
  })

  assert.deepEqual(await provider.searchMany(['  useful query  '], 2), [
    { title: 'First result', url: 'https://example.com/first', snippet: 'A useful snippet' },
    { title: 'Second result', url: 'https://example.org/second', snippet: 'Second snippet' }
  ])
  assert.equal(requestedUrl?.pathname, '/search')
  assert.equal(requestedUrl?.searchParams.get('q'), 'useful query')
  assert.equal(requestedUrl?.searchParams.get('format'), 'json')
  assert.equal(requestOptions?.redirect, 'error')
})

test('limits query fanout and result count per query', async () => {
  const requestedQueries: string[] = []
  const provider = new SearxngSearchProvider({
    baseUrl: 'http://127.0.0.1:8888',
    fetcher: async input => {
      const query = new URL(String(input)).searchParams.get('q') ?? ''
      requestedQueries.push(query)
      return new Response(JSON.stringify({
        results: Array.from({ length: 8 }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://example.com/${query}/${index}`,
          content: `Snippet ${index}`
        }))
      }))
    }
  })

  const results = await provider.searchMany(['one', 'two', 'three', 'four'], 2)

  assert.deepEqual(requestedQueries, ['one', 'two', 'three'])
  assert.equal(results.length, 6)
})

test('surfaces HTTP failures without echoing the response body', async () => {
  const provider = new SearxngSearchProvider({
    baseUrl: 'http://127.0.0.1:8888',
    fetcher: async () => new Response('private upstream details', { status: 503 })
  })

  await assert.rejects(
    () => provider.searchMany(['query']),
    error => error instanceof Error &&
      /SearXNG search returned HTTP 503/.test(error.message) &&
      !error.message.includes('private upstream details')
  )
})

test('honors cancellation before making a network request', async () => {
  let requests = 0
  const provider = new SearxngSearchProvider({
    baseUrl: 'http://127.0.0.1:8888',
    fetcher: async () => {
      requests += 1
      return new Response('{"results":[]}')
    }
  })
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(() => provider.searchMany(['query'], 3, controller.signal))
  assert.equal(requests, 0)
})

test('rejects an oversized response before parsing it', async () => {
  const provider = new SearxngSearchProvider({
    baseUrl: 'http://127.0.0.1:8888',
    maxResponseBytes: 16,
    fetcher: async () => new Response('x'.repeat(32))
  })

  await assert.rejects(() => provider.searchMany(['query']), /response exceeded configured size limit/)
})
