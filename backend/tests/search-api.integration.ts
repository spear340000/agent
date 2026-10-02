import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRouter } from '../src/api/router.js';
import { createApiServer } from '../src/api/server.js';
import { ApiAuthenticator } from '../src/api/authentication.js';

test('web search bounds requests and returns only actually retrieved source content', async () => {
  const router = new ApiRouter({ authenticator: new ApiAuthenticator(), browser: { search: async (query: string) => [{ title: 'Result', url: 'https://example.com/', snippet: query, content: 'Verified page content', retrievedAt: '2026-09-30', retrievalStatus: 'retrieved' }] } } as never);
  const server = createApiServer(router);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const result = await post({ query: '문서 자동화', limit: 3 });
    assert.equal(result.status, 200);
    const body = await result.json() as { items: Array<{ content: string; snippet: string }> };
    assert.equal(body.items[0]!.snippet, '문서 자동화');
    assert.equal(body.items[0]!.content, 'Verified page content');
    assert.equal((await post({ query: 'x', limit: 5000 })).status, 400);
    assert.equal((await post({ query: '' })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
