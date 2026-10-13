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

test('a server-side failure from a provider with a fallback makes the failover skip that model for a minute', async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const provider = new OpenAiProvider({ apiKey: 'test', model: 'm', baseUrl: `http://127.0.0.1:${port}`, maxAttempts: 1, failFastOnRateLimit: true });
    await assert.rejects(
      () => provider.complete({ system: 's', user: 'u' }),
      (error: Error & { retryAfterMs?: number }) => error.retryAfterMs === 60_000
    );
    const lone = new OpenAiProvider({ apiKey: 'test', model: 'm', baseUrl: `http://127.0.0.1:${port}`, maxAttempts: 1 });
    await assert.rejects(
      () => lone.complete({ system: 's', user: 'u' }),
      (error: Error & { retryAfterMs?: number }) => error.retryAfterMs === undefined
    );
  } finally {
    server.close();
  }
});

test('with a fallback configured a token window that frees up in 20 seconds is skipped instead of waited for', async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 2_500, prompt_tokens: 2_000, completion_tokens: 500 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let clock = 0;
  try {
    const provider = new OpenAiProvider({ apiKey: 'test', model: 'm', baseUrl: `http://127.0.0.1:${port}`, tokensPerMinute: 3_000, failFastOnRateLimit: true, now: () => clock });
    const input = { system: 'x'.repeat(100), user: 'y'.repeat(100), expectedOutputTokens: 500 };
    assert.equal(await provider.complete(input), 'ok');
    clock = 40_000;
    await assert.rejects(
      () => provider.complete(input),
      (error: Error & { retryAfterMs?: number }) => /다음 모델로 전환/.test(error.message) && error.retryAfterMs === 20_000
    );
  } finally {
    server.close();
  }
});
