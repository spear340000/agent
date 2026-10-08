import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiProvider } from '../src/infrastructure/llm/openai-provider.ts';

test('a full token window is reported in Korean with the wait it avoided', async () => {
  const provider = new OpenAiProvider({ apiKey: 'test', model: 'm', baseUrl: 'http://127.0.0.1:1', tokensPerMinute: 1_000 });
  await assert.rejects(
    () => provider.complete({ system: 'x'.repeat(100), user: 'y'.repeat(100), expectedOutputTokens: 2_000 }),
    (error: Error) => /분당 토큰 한도보다 커서/.test(error.message)
  );
});

test('a request that fails before any usage is reported gives its token reservation back', async () => {
  const provider = new OpenAiProvider({ apiKey: 'test', model: 'm', baseUrl: 'http://127.0.0.1:1', tokensPerMinute: 3_000, maxAttempts: 1 });
  const input = { system: 'x'.repeat(100), user: 'y'.repeat(100) };
  for (let call = 0; call < 3; call += 1) {
    await assert.rejects(() => provider.complete(input), (error: Error) => /연결을 확인하세요/.test(error.message), `call ${call + 1} reaches the provider instead of finding a full window`);
  }
});

test('a 429 from a provider with a fallback is not retried and asks the failover to skip that model', async () => {
  const http = await import('node:http');
  let requests = 0;
  const server = http.createServer((_req, res) => { requests += 1; res.writeHead(429, { 'retry-after': '12', 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const provider = new OpenAiProvider({ apiKey: 'test', model: 'm', baseUrl: `http://127.0.0.1:${port}`, maxAttempts: 3, failFastOnRateLimit: true });
    await assert.rejects(
      () => provider.complete({ system: 's', user: 'u' }),
      (error: Error & { retryAfterMs?: number }) => error.retryAfterMs === 12_000
    );
    assert.equal(requests, 1, 'no retries against a rate limit when another provider can answer');
  } finally {
    server.close();
  }
});
