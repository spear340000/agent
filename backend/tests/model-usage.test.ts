import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ModelFailoverProvider } from '../src/infrastructure/llm/model-failover-provider.ts';
import { runWithModelAttempts, summarizeModelAttempts, tokensPerSecond, type ModelAttempt } from '../src/infrastructure/llm/model-attempts.ts';
import { OpenAiProvider } from '../src/infrastructure/llm/openai-provider.ts';

test('totals add up tokens and time, and speed counts only successful generating calls', () => {
  const attempts: ModelAttempt[] = [
    { model: 'a', ok: false, ms: 5_000, error: 'HTTP 429' },
    { model: 'b', ok: true, ms: 2_000, promptTokens: 1_000, completionTokens: 100 },
    { model: 'b', ok: true, ms: 3_000, promptTokens: 2_000, completionTokens: 400 }
  ];
  const { totals, finalModel, fellBack } = summarizeModelAttempts(attempts);
  assert.equal(finalModel, 'b');
  assert.equal(fellBack, true);
  assert.deepEqual({ calls: totals.calls, failed: totals.failedCalls, input: totals.promptTokens, output: totals.completionTokens, ms: totals.totalMs }, { calls: 3, failed: 1, input: 3_000, output: 500, ms: 10_000 });
  assert.equal(totals.tokensPerSecond, 100, '500 tokens over the 5 seconds the successful calls took');
  const waited = summarizeModelAttempts([{ model: 'c', ok: true, ms: 40_000, requestMs: 4_000, promptTokens: 10, completionTokens: 400 }]).totals;
  assert.equal(waited.tokensPerSecond, 100, 'time spent waiting for the token window is not counted as generation time');
  assert.equal(tokensPerSecond(100, 2_000), 50);
  assert.equal(tokensPerSecond(undefined, 2_000), undefined);
  assert.equal(summarizeModelAttempts([]).totals.tokensPerSecond, null);
});

test('the usage a provider reports reaches the recorded attempt', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '답변' } }], usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const openai = new OpenAiProvider({ apiKey: 'test', model: 'm', baseUrl: `http://127.0.0.1:${port}` });
    const failover = new ModelFailoverProvider([{ name: 'local', complete: input => openai.complete(input) }]);
    const attempts: ModelAttempt[] = [];
    await runWithModelAttempts(attempts, () => failover.complete({ system: 's', user: 'u' }));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.promptTokens, 120);
    assert.equal(attempts[0]!.completionTokens, 45);
    assert.ok(summarizeModelAttempts(attempts).totals.tokensPerSecond! > 0);
  } finally {
    server.close();
  }
});
