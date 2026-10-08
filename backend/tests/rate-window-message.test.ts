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
