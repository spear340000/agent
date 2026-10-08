import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModelProviderConfig } from '../src/config/model-providers.js';
import { ModelFailoverProvider } from '../src/infrastructure/llm/model-failover-provider.js';
import { ModelProviderError } from '../src/infrastructure/llm/model-provider-error.js';
import { OpenAiProvider } from '../src/infrastructure/llm/openai-provider.js';

test('model requests fall through to the next configured provider after an upstream failure', async () => {
  const calls: string[] = [];
  const provider = new ModelFailoverProvider([
    { name: 'NVIDIA primary', complete: async () => { calls.push('primary'); throw new ModelProviderError('HTTP 503'); } },
    { name: 'NVIDIA backup', complete: async input => { calls.push(input.user); return 'backup answer'; } },
  ]);

  assert.equal(await provider.complete({ system: 'legal system', user: 'question' }), 'backup answer');
  assert.deepEqual(calls, ['primary', 'question']);
  assert.equal(provider.lastSuccessfulModel, 'NVIDIA backup');
});

test('a catalog-listed but unavailable NVIDIA model is skipped so the next NVIDIA model can answer', async () => {
  const calls: string[] = [];
  const provider = new ModelFailoverProvider([
    { name: 'NVIDIA unavailable model', complete: async () => { calls.push('missing'); throw new ModelProviderError('HTTP 404'); } },
    { name: 'NVIDIA available model', complete: async () => { calls.push('available'); return 'answer'; } },
  ]);

  assert.equal(await provider.complete({ system: 's', user: 'u' }), 'answer');
  assert.deepEqual(calls, ['missing', 'available']);
});

test('an actual OpenAI-compatible 503 on the primary endpoint retries using the configured backup model', async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; model: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { model: string };
    requests.push({ url, model: body.model });
    if (body.model === 'nvidia/primary') return Response.json({ error: { message: 'private provider detail' } }, { status: 503 });
    return Response.json({ choices: [{ message: { content: 'backup model answered' } }] });
  };
  try {
    const provider = new ModelFailoverProvider([
      { name: 'NVIDIA · primary', complete: input => new OpenAiProvider({ apiKey: 'nvidia-secret', model: 'nvidia/primary', baseUrl: 'https://nvidia.example/v1', maxAttempts: 1 }).complete(input) },
      { name: 'NVIDIA · backup', complete: input => new OpenAiProvider({ apiKey: 'nvidia-secret', model: 'nvidia/backup', baseUrl: 'https://nvidia.example/v1', maxAttempts: 1 }).complete(input) },
    ]);

    assert.equal(await provider.complete({ system: 'system', user: 'question' }), 'backup model answered');
    assert.deepEqual(requests, [
      { url: 'https://nvidia.example/v1/chat/completions', model: 'nvidia/primary' },
      { url: 'https://nvidia.example/v1/chat/completions', model: 'nvidia/backup' },
    ]);
    assert.equal(provider.lastSuccessfulModel, 'NVIDIA · backup');
  } finally { globalThis.fetch = original; }
});

test('model requests do not fall through after caller cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  let backupCalls = 0;
  const provider = new ModelFailoverProvider([
    { name: 'primary', complete: async () => { throw new Error('model request cancelled'); } },
    { name: 'backup', complete: async () => { backupCalls += 1; return 'unexpected'; } },
  ]);

  await assert.rejects(() => provider.complete({ system: 's', user: 'u', signal: controller.signal }), /cancelled/);
  assert.equal(backupCalls, 0);
});

test('NVIDIA fallbacks precede the cheapest OpenAI fallback with isolated credentials', () => {
  const config = resolveModelProviderConfig({
    NVIDIA_API_KEY: 'nvidia-secret',
    NVIDIA_BASE_URL: 'https://integrate.example/v1',
    NVIDIA_MODEL: 'nvidia/model-a',
    OPENAI_API_KEY: 'openai-secret',
    OPENAI_MODEL: 'openai/model-b',
    NVIDIA_FALLBACK_MODELS: 'nvidia/model-c, nvidia/model-d, nvidia/model-e',
  });

  assert.equal(config.primary.model, 'nvidia/model-a');
  assert.deepEqual(config.fallbacks.map(candidate => candidate.model), [
    'nvidia/model-c', 'nvidia/model-d', 'nvidia/model-e', 'gpt-5-nano',
  ]);
  assert.equal(config.fallbacks.slice(0, 3).every(candidate => candidate.apiKey === 'nvidia-secret' && candidate.baseUrl === 'https://integrate.example/v1'), true);
  assert.equal(config.fallbacks[3]?.apiKey, 'openai-secret');
  assert.equal(config.fallbacks[3]?.baseUrl, 'https://api.openai.com/v1');
  assert.equal(JSON.stringify(config.fallbacks.map(({ name, model, baseUrl }) => ({ name, model, baseUrl }))).includes('secret'), false);
});

test('provider-wide failure skips same-endpoint models but can use another provider', async () => {
  const calls: string[] = [];
  const provider = new ModelFailoverProvider([
    { name: 'primary', failureDomain: 'nvidia', complete: async () => { calls.push('primary'); throw new ModelProviderError('credits exhausted', false, true); } },
    { name: 'backup', failureDomain: 'nvidia', complete: async () => { calls.push('backup'); return 'unexpected'; } },
    { name: 'OpenAI', failureDomain: 'openai', complete: async () => { calls.push('openai'); return 'answer'; } },
  ]);
  assert.equal(await provider.complete({ system: 's', user: 'u' }), 'answer');
  assert.deepEqual(calls, ['primary', 'openai']);
});

test('NVIDIA HTTP failures reach OpenAI without changing the prompt or leaking credentials', async () => {
  const original = globalThis.fetch;
  const config = resolveModelProviderConfig({ NVIDIA_API_KEY: 'nv-secret', NVIDIA_MODEL: 'nvidia/primary', OPENAI_API_KEY: 'oa-secret' });
  const requests: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), authorization: (init?.headers as Record<string, string>).authorization, body: JSON.parse(String(init?.body)) });
    if (String(input).startsWith('https://integrate.api.nvidia.com/')) return Response.json({ error: {} }, { status: 503 });
    return Response.json({ choices: [{ message: { content: 'OpenAI answer' } }] });
  };
  try {
    const provider = new ModelFailoverProvider([config.primary, ...config.fallbacks].map(endpoint => ({
      name: endpoint.model, failureDomain: endpoint.baseUrl,
      complete: input => new OpenAiProvider({ ...endpoint, maxAttempts: 1 }).complete(input),
    })));
    assert.equal(await provider.complete({ system: 's', user: 'original question' }), 'OpenAI answer');
    assert.equal(requests.length, 4);
    assert.equal(requests.at(-1)?.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(requests.at(-1)?.authorization, 'Bearer oa-secret');
    assert.equal(requests.slice(0, -1).every(request => request.authorization === 'Bearer nv-secret'), true);
    assert.deepEqual(requests.at(-1)?.body, { model: 'gpt-5-nano', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'original question' }] });
    assert.equal(provider.lastSuccessfulModel, 'gpt-5-nano');
  } finally { globalThis.fetch = original; }
});

test('the primary NVIDIA model is not repeated as its own fallback', () => {
  const config = resolveModelProviderConfig({
    NVIDIA_API_KEY: 'same-secret',
    NVIDIA_BASE_URL: 'https://api.example/v1/',
    NVIDIA_MODEL: 'nvidia/same-model',
    NVIDIA_FALLBACK_MODELS: 'nvidia/same-model',
  });

  assert.deepEqual(config.fallbacks, []);
});

test('NVIDIA credentials receive the configured default NVIDIA model fallbacks', () => {
  const config = resolveModelProviderConfig({ NVIDIA_API_KEY: 'nvidia-secret', NVIDIA_MODEL: 'nvidia/current-primary' });
  assert.deepEqual(config.fallbacks.map(candidate => candidate.model), [
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
  ]);
});

test('all provider failures produce a safe summary without exposing response bodies', async () => {
  const provider = new ModelFailoverProvider([
    { name: 'NVIDIA', complete: async () => { throw new ModelProviderError('HTTP 503'); } },
    { name: 'NVIDIA secondary', complete: async () => { throw new ModelProviderError('HTTP 429'); } },
  ]);

  await assert.rejects(() => provider.complete({ system: 's', user: 'u' }), error => {
    assert.match((error as Error).message, /NVIDIA: HTTP 503.*NVIDIA secondary: HTTP 429/);
    assert.doesNotMatch((error as Error).message, /secret|Bearer|response body/i);
    return true;
  });
});

test('a non-provider input error is not retried against backup models', async () => {
  let backupCalls = 0;
  const provider = new ModelFailoverProvider([
    { name: 'primary', complete: async () => { throw new Error('model input exceeds configured limit'); } },
    { name: 'backup', complete: async () => { backupCalls += 1; return 'unexpected'; } },
  ]);

  await assert.rejects(() => provider.complete({ system: 's', user: 'u' }), /input exceeds/);
  assert.equal(backupCalls, 0);
});

test('account-wide billing failures do not consume attempts on every NVIDIA model', async () => {
  let backupCalls = 0;
  const provider = new ModelFailoverProvider([
    { name: 'NVIDIA primary', complete: async () => { throw new ModelProviderError('credits exhausted', false); } },
    { name: 'NVIDIA secondary', complete: async () => { backupCalls += 1; return 'unexpected'; } },
  ]);

  await assert.rejects(() => provider.complete({ system: 's', user: 'u' }), /credits exhausted/);
  assert.equal(backupCalls, 0);
});

test('non-NVIDIA fallback model IDs are rejected', () => {
  assert.throws(() => resolveModelProviderConfig({ NVIDIA_API_KEY: 'secret', NVIDIA_FALLBACK_MODELS: 'openai/model-id' }), /only NVIDIA model IDs/);
});

test('HTTP auth and quota errors skip the NVIDIA account and use the OpenAI account', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 403, 429]) {
      const requests: string[] = [];
      globalThis.fetch = async input => {
        requests.push(String(input));
        if (String(input).includes('nvidia.example')) return Response.json({ error: { code: status === 429 ? 'insufficient_quota' : 'invalid_key' } }, { status });
        return Response.json({ choices: [{ message: { content: 'answer' } }] });
      };
      const endpoints = [
        { name: 'NVIDIA', apiKey: 'nv', model: 'primary', baseUrl: 'https://nvidia.example/v1' },
        { name: 'NVIDIA backup', apiKey: 'nv', model: 'backup', baseUrl: 'https://nvidia.example/v1' },
        { name: 'OpenAI', apiKey: 'oa', model: 'gpt-5-nano', baseUrl: 'https://api.openai.com/v1' },
      ];
      const provider = new ModelFailoverProvider(endpoints.map(endpoint => ({
        name: endpoint.name, failureDomain: endpoint.baseUrl,
        complete: input => new OpenAiProvider({ ...endpoint, maxAttempts: 1 }).complete(input),
      })));
      assert.equal(await provider.complete({ system: 's', user: 'u' }), 'answer');
      assert.deepEqual(requests, ['https://nvidia.example/v1/chat/completions', 'https://api.openai.com/v1/chat/completions']);
    }
  } finally { globalThis.fetch = original; }
});

test('OpenAI fallback model and endpoint are configurable independently of NVIDIA', () => {
  const config = resolveModelProviderConfig({ NVIDIA_API_KEY: 'nv', OPENAI_API_KEY: 'oa', OPENAI_FALLBACK_MODEL: 'selected-model', OPENAI_BASE_URL: 'https://openai.example/v1/' });
  assert.equal(config.fallbacks.at(-1)?.model, 'selected-model');
  assert.equal(config.fallbacks.at(-1)?.baseUrl, 'https://openai.example/v1');
});

test('each task records its own failed and final models, even when tasks run concurrently', async () => {
  const { runWithModelAttempts, summarizeModelAttempts } = await import('../src/infrastructure/llm/model-attempts.ts');
  const { ModelProviderError } = await import('../src/infrastructure/llm/model-provider-error.ts');
  const gate = Promise.resolve();
  const provider = new ModelFailoverProvider([
    { name: 'primary', complete: async () => { await gate; throw new ModelProviderError('down'); } },
    { name: 'backup', complete: async () => { await gate; return 'ok'; } }
  ]);
  const a: Array<import('../src/infrastructure/llm/model-attempts.ts').ModelAttempt> = [];
  const b: Array<import('../src/infrastructure/llm/model-attempts.ts').ModelAttempt> = [];
  await Promise.all([
    runWithModelAttempts(a, () => provider.complete({ system: 's', user: 'u' })),
    runWithModelAttempts(b, () => provider.complete({ system: 's', user: 'u' }))
  ]);
  assert.deepEqual(a.map(item => [item.model, item.ok]), [['primary', false], ['backup', true]]);
  assert.deepEqual(b.map(item => [item.model, item.ok]), [['primary', false], ['backup', true]]);
  assert.deepEqual(summarizeModelAttempts(a), { finalModel: 'backup', fellBack: true, failedModels: ['primary'] });
});

test('an account that reported exhausted credit is skipped for the cooldown, then retried', async () => {
  let clock = 1_000;
  const calls: string[] = [];
  const provider = new ModelFailoverProvider([
    { name: 'broke', failureDomain: 'acct-a', complete: async () => { calls.push('broke'); throw new ModelProviderError('credit exhausted', false, true); } },
    { name: 'ok', failureDomain: 'acct-b', complete: async () => { calls.push('ok'); return 'answer'; } }
  ], { unhealthyCooldownMs: 60_000, now: () => clock });
  assert.equal(await provider.complete({ system: 's', user: 'u' }), 'answer');
  assert.equal(await provider.complete({ system: 's', user: 'u' }), 'answer');
  assert.deepEqual(calls, ['broke', 'ok', 'ok'], 'the second request goes straight to the healthy account');
  clock += 61_000;
  await provider.complete({ system: 's', user: 'u' });
  assert.deepEqual(calls, ['broke', 'ok', 'ok', 'broke', 'ok'], 'the account is retried after the cooldown');
});

test('when every account is in cooldown they are all tried again instead of failing outright', async () => {
  const calls: string[] = [];
  const provider = new ModelFailoverProvider([
    { name: 'only', failureDomain: 'acct', complete: async () => { calls.push('only'); if (calls.length === 1) throw new ModelProviderError('bad key', false, true); return 'recovered'; } }
  ], { unhealthyCooldownMs: 60_000 });
  await assert.rejects(() => provider.complete({ system: 's', user: 'u' }));
  assert.equal(await provider.complete({ system: 's', user: 'u' }), 'recovered');
});

test('sequential provider failures stop once the total time budget is spent', async () => {
  let clock = 0;
  const calls: string[] = [];
  const slowFail = (name: string) => ({ name, complete: async () => { calls.push(name); clock += 50_000; throw new ModelProviderError(`${name} timed out`); } });
  const provider = new ModelFailoverProvider([slowFail('a'), slowFail('b'), slowFail('c')], { totalBudgetMs: 90_000, now: () => clock });
  await assert.rejects(() => provider.complete({ system: 's', user: 'u' }), /시간 예산/);
  assert.deepEqual(calls, ['a', 'b'], 'c is never tried');
});

test('a Groq key makes Groq the primary model and keeps the other providers as ordered fallbacks', () => {
  const config = resolveModelProviderConfig({
    GROQ_API_KEY: 'gsk-secret', GROQ_FALLBACK_MODELS: 'qwen/qwen3.8-27b, openai/gpt-oss-120b',
    NVIDIA_API_KEY: 'nv-secret', NVIDIA_MODEL: 'nvidia/big', OPENAI_API_KEY: 'oa-secret'
  });
  assert.deepEqual([config.primary.name, config.primary.model, config.primary.baseUrl], ['Groq', 'openai/gpt-oss-120b', 'https://api.groq.com/openai/v1']);
  assert.deepEqual(config.fallbacks.map(item => `${item.name}:${item.model}`), [
    'Groq:qwen/qwen3.8-27b', 'NVIDIA:nvidia/big', 'NVIDIA NIM:nvidia/nemotron-3-super-120b-a12b', 'NVIDIA NIM:nvidia/nemotron-3.5-lightning-30b-a3b', 'OpenAI:gpt-5-nano'
  ]);
  assert.equal(JSON.stringify(config).includes('undefined'), false);
});

test('without a Groq key the configuration is unchanged, and Groq alone works', () => {
  assert.equal(resolveModelProviderConfig({ NVIDIA_API_KEY: 'nv' }).primary.name, 'NVIDIA');
  const only = resolveModelProviderConfig({ GROQ_API_KEY: 'gsk', GROQ_MODEL: 'qwen/qwen3.8-27b' });
  assert.deepEqual([only.primary.name, only.primary.model, only.fallbacks.length], ['Groq', 'qwen/qwen3.8-27b', 0]);
});

test('an endpoint with a small input limit is skipped for oversized requests instead of failing the request', async () => {
  const calls: string[] = [];
  const small = new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://small.example/v1', maxInputCharacters: 50 });
  const provider = new ModelFailoverProvider([
    { name: 'small', failureDomain: 'small', complete: input => small.complete(input) },
    { name: 'large', failureDomain: 'large', complete: async () => { calls.push('large'); return 'ok'; } }
  ]);
  assert.equal(await provider.complete({ system: 's', user: 'x'.repeat(200) }), 'ok');
  assert.deepEqual(calls, ['large']);
});

test('the Groq input limit is configurable and defaults below the free-tier request size', () => {
  assert.equal(resolveModelProviderConfig({ GROQ_API_KEY: 'g' }).primary.maxInputCharacters, 11_000);
  assert.equal(resolveModelProviderConfig({ GROQ_API_KEY: 'g', GROQ_MAX_INPUT_CHARACTERS: '20000' }).primary.maxInputCharacters, 20_000);
  assert.equal(resolveModelProviderConfig({ NVIDIA_API_KEY: 'n' }).primary.maxInputCharacters, undefined);
});

test('the token rate limiter waits for the window to free up and reports requests that can never fit', async () => {
  const { TokenRateLimiter, estimateTokens } = await import('../src/infrastructure/llm/token-rate-limiter.ts');
  let clock = 0;
  const limiter = new TokenRateLimiter(8_000, () => clock);
  assert.equal(limiter.waitMs(5_000), 0);
  limiter.record(5_000);
  clock = 10_000;
  assert.equal(limiter.waitMs(2_000), 0, '5k + 2k still fits in 8k');
  limiter.record(2_000);
  assert.equal(limiter.waitMs(3_000), 50_000, 'must wait until the first 5k leaves the window (60s after t=0)');
  clock = 60_000;
  assert.equal(limiter.waitMs(3_000), 0);
  assert.equal(limiter.waitMs(9_000), Infinity);
  assert.ok(estimateTokens(1_600) >= 1_000 + 2_000);
});

test('a provider whose token window is full hands the request to the next provider instead of waiting too long', async () => {
  let clock = 0;
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls.push('http'); return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }); }) as typeof fetch;
  try {
    const tight = new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://tight.example/v1', tokensPerMinute: 4_000, now: () => clock });
    const provider = new ModelFailoverProvider([
      { name: 'tight', failureDomain: 'tight', complete: input => tight.complete(input) },
      { name: 'backup', failureDomain: 'backup', complete: async () => { calls.push('backup'); return 'from backup'; } }
    ]);
    const big = { system: 's', user: 'x'.repeat(3_000) };
    assert.equal(await provider.complete(big), 'ok');
    assert.equal(await provider.complete(big), 'from backup', 'the second request would wait about a minute, so the backup answers');
    assert.deepEqual(calls, ['http', 'backup']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('reported token usage replaces the reservation, and helper calls reserve less than full answers', async () => {
  const { TokenRateLimiter, estimateTokens } = await import('../src/infrastructure/llm/token-rate-limiter.ts');
  const limiter = new TokenRateLimiter(8_000, () => 0);
  const reservation = limiter.record(estimateTokens(3_200));
  assert.equal(limiter.waitMs(5_000), 0 + (estimateTokens(3_200) + 5_000 > 8_000 ? 60_000 : 0), 'the large reservation blocks a big follow-up');
  limiter.settle(reservation, 900);
  assert.equal(limiter.waitMs(5_000), 0, 'after settling to the real 900 tokens the follow-up fits');
  limiter.settle(reservation, 0);
  assert.equal(limiter.waitMs(7_200), 60_000, 'a non-positive report is ignored and 900 stays reserved');
  assert.ok(estimateTokens(3_200, 400) < estimateTokens(3_200), 'a short JSON verdict reserves less than a full answer');
});

test('the provider settles its rate reservation from the usage the API reports', async () => {
  let clock = 0;
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 500 } }), { status: 200 }); }) as typeof fetch;
  try {
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://tight.example/v1', tokensPerMinute: 6_000, now: () => clock });
    const input = { system: 's', user: 'x'.repeat(1_600) };
    for (let round = 0; round < 5; round += 1) assert.equal(await provider.complete(input), 'ok');
    assert.equal(calls, 5, 'five requests fit because each was settled to 500 tokens, not the 3,000-token estimate');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a rate-limited model is skipped until its cooldown ends instead of being retried on every call', async () => {
  let clock = 1_000;
  const calls: string[] = [];
  const provider = new ModelFailoverProvider([
    { name: 'limited', complete: async () => { calls.push('limited'); throw new ModelProviderError('HTTP 429', true, false, 30_000); } },
    { name: 'backup', complete: async () => { calls.push('backup'); return 'answer'; } },
  ], { now: () => clock });

  await provider.complete({ system: 's', user: 'u' });
  await provider.complete({ system: 's', user: 'u' });
  assert.deepEqual(calls, ['limited', 'backup', 'backup'], 'the second call does not touch the limited model');
  clock += 31_000;
  await provider.complete({ system: 's', user: 'u' });
  assert.deepEqual(calls, ['limited', 'backup', 'backup', 'limited', 'backup'], 'after the cooldown it is tried again');
});

test('when every model is cooling down they are all tried again rather than failing outright', async () => {
  const provider = new ModelFailoverProvider([
    { name: 'only', complete: async () => { throw new ModelProviderError('HTTP 429', true, false, 30_000); } },
  ], { now: () => 1_000 });
  await assert.rejects(() => provider.complete({ system: 's', user: 'u' }));
  await assert.rejects(() => provider.complete({ system: 's', user: 'u' }), /모든 모델 제공자/);
});
