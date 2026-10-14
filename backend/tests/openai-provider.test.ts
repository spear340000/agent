import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiProvider } from '../src/infrastructure/llm/openai-provider.js';
import { ModelProviderError } from '../src/infrastructure/llm/model-provider-error.js';

test('exhausted credits surface a safe actionable error without futile retries or secret leakage', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { code: 'credit_balance_exhausted', type: 'insufficient_quota', message: 'DO_NOT_EXPOSE_RESPONSE_SECRET' } }, { status: 429 }); };
  try {
    const provider = new OpenAiProvider({ apiKey: 'test-secret', model: 'test', baseUrl: 'https://example.com' });
    await assert.rejects(() => provider.complete({ system: 's', user: 'u' }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /크레딧.*소진/);
      assert.doesNotMatch(error.message, /DO_NOT_EXPOSE|test-secret/);
      return true;
    });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('provider rejects oversized user input before making a request', async () => {
  const provider = new OpenAiProvider({ apiKey: 'test-secret', model: 'test', baseUrl: 'https://example.com', maxInputCharacters: 8 });
  await assert.rejects(() => provider.complete({ system: 'sys', user: '0123456' }), /input exceeds/);
});

test('malformed provider error payloads still report the HTTP failure without leaking an internal TypeError', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json(null, { status: 401 });
  try {
    const provider = new OpenAiProvider({ apiKey: 'test-secret', model: 'test', baseUrl: 'https://example.com' });
    await assert.rejects(() => provider.complete({ system: 's', user: 'u' }), /HTTP 401.*API 키/);
  } finally { globalThis.fetch = original; }
});

test('provider bounds successful response bodies and exposes no response payload', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(100) } }] }), { headers: { 'content-type': 'application/json' } }); };
  try {
    const provider = new OpenAiProvider({ apiKey: 'test-secret', model: 'test', baseUrl: 'https://example.com', maxOutputBytes: 32 });
    await assert.rejects(() => provider.complete({ system: 's', user: 'u' }), /response exceeded configured size limit/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('provider retries transient HTTP failures with a bounded retry count', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls < 3 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  try {
    const provider = new OpenAiProvider({ apiKey: 'test-secret', model: 'test', baseUrl: 'https://example.com', retryBaseDelayMs: 0 });
    assert.equal(await provider.complete({ system: 's', user: 'u' }), 'ok');
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test('an exhausted upstream 503 is identified as eligible for model failover without exposing its body', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ error: { message: 'PRIVATE_UPSTREAM_DETAIL' } }, { status: 503 }); };
  try {
    const provider = new OpenAiProvider({ apiKey: 'test-secret', model: 'test', baseUrl: 'https://example.com', maxAttempts: 1 });
    await assert.rejects(() => provider.complete({ system: 's', user: 'u' }), error => {
      assert.ok(error instanceof ModelProviderError);
      assert.equal(error.fallbackEligible, true);
      assert.match(error.message, /HTTP 503/);
      assert.doesNotMatch(error.message, /PRIVATE_UPSTREAM_DETAIL|test-secret/);
      return true;
    });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('provider retries timeout failures at most three times', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  try {
    const provider = new OpenAiProvider({ apiKey: 'test-secret', model: 'test', baseUrl: 'https://example.com', retryBaseDelayMs: 0 });
    await assert.rejects(() => provider.complete({ system: 's', user: 'u' }), /failed or timed out/);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test('provider cancellation interrupts retry backoff', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async () => new Response('', { status: 503, headers: { 'retry-after': '5' } });
  try {
    const provider = new OpenAiProvider({ apiKey: 'test-secret', model: 'test', baseUrl: 'https://example.com' });
    const completion = provider.complete({ system: 's', user: 'u', signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(() => completion, /cancelled/);
  } finally { globalThis.fetch = original; }
});
