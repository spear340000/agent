import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../src/infrastructure/legal/mcp-stdio-client.ts';

const fixture = fileURLToPath(new URL('./mcp-fixture.ts', import.meta.url));
const runner = fileURLToPath(new URL('./bootstrap.ts', import.meta.url));

const client = (mode: string, overrides: Partial<{ startupTimeoutMs: number; requestTimeoutMs: number; maxResponseCharacters: number; restartBudget: number; restartWindowMs: number }> = {}) =>
  new McpStdioClient({
    command: process.execPath,
    args: [runner, fixture, mode],
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH ?? '' },
    startupTimeoutMs: overrides.startupTimeoutMs ?? 20_000,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 5_000,
    maxResponseCharacters: overrides.maxResponseCharacters ?? 2_000_000,
    restartBudget: overrides.restartBudget ?? 1,
    ...(overrides.restartWindowMs !== undefined ? { restartWindowMs: overrides.restartWindowMs } : {}),
    stderrTailCharacters: 1_000
  });

test('the client completes the handshake and correlates JSON-RPC ids', async () => {
  const mcp = client('ok');
  try {
    const [first, second] = await Promise.all([mcp.callTool('echo', { query: '첫 번째' }), mcp.callTool('echo', { query: '두 번째' })]);
    assert.equal(first.isError, false);
    assert.match(first.text, /첫 번째/);
    assert.match(second.text, /두 번째/);
  } finally {
    await mcp.close();
  }
});

test('tool-level errors are returned instead of throwing', async () => {
  const mcp = client('ok');
  try {
    const result = await mcp.callTool('fail', {});
    assert.equal(result.isError, true);
    assert.match(result.text, /Error: 실패/);
  } finally {
    await mcp.close();
  }
});

test('a missing process is a startup failure, not a silent empty result', async () => {
  const mcp = new McpStdioClient({
    command: path.join(os.tmpdir(), 'workfolio-missing-python-binary'),
    args: [],
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH ?? '' },
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 1_000,
    maxResponseCharacters: 10_000,
    restartBudget: 1,
    stderrTailCharacters: 200
  });
  await assert.rejects(() => mcp.callTool('echo', { query: 'x' }), (error: { kind?: string }) => error.kind === 'startup');
  await mcp.close();
});

test('a non-JSON protocol line is a malformed result failure', async () => {
  const mcp = client('malformed', { restartBudget: 0 });
  try {
    await assert.rejects(() => mcp.callTool('echo', { query: 'x' }), (error: { kind?: string }) => error.kind === 'malformed');
  } finally {
    await mcp.close();
  }
});

test('a request timeout is distinct from a transport failure', async () => {
  const mcp = client('hang', { requestTimeoutMs: 300, restartBudget: 1 });
  try {
    await assert.rejects(() => mcp.callTool('slow', {}), (error: { kind?: string }) => error.kind === 'timeout');
  } finally {
    await mcp.close();
  }
});

test('a child that dies mid-session is restarted once on a later request', async () => {
  const mcp = client('crash-after-first', { restartBudget: 1 });
  try {
    assert.equal((await mcp.callTool('echo', { query: '첫 요청' })).isError, false);
    await assert.rejects(() => mcp.callTool('echo', { query: '두 번째' }), (error: { kind?: string }) => error.kind === 'transport');
    assert.equal((await mcp.callTool('echo', { query: '재시작된 요청' })).isError, false, 'the child is restarted once on a later request');
    await assert.rejects(() => mcp.callTool('echo', { query: '다시 실패' }), (error: { kind?: string }) => error.kind === 'transport');
    await assert.rejects(() => mcp.callTool('echo', { query: '재시도 없음' }), (error: { kind?: string; message?: string }) => {
      assert.equal(error.kind, 'transport');
      assert.match(String(error.message), /restart/);
      return true;
    });
  } finally {
    await mcp.close();
  }
});

test('with a restart window, the restart budget recovers instead of staying exhausted', async () => {
  const mcp = client('crash-after-first', { restartBudget: 1, restartWindowMs: 300 });
  try {
    assert.equal((await mcp.callTool('echo', { query: '첫 요청' })).isError, false);
    await assert.rejects(() => mcp.callTool('echo', { query: '두 번째' }), (error: { kind?: string }) => error.kind === 'transport');
    assert.equal((await mcp.callTool('echo', { query: '재시작 1' })).isError, false);
    await assert.rejects(() => mcp.callTool('echo', { query: '다시 실패' }), (error: { kind?: string }) => error.kind === 'transport');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal((await mcp.callTool('echo', { query: '창이 지난 뒤 복구' })).isError, false, 'the budget is restored once the window passes');
  } finally {
    await mcp.close();
  }
});

test('oversized protocol output is bounded', async () => {
  const mcp = client('ok', { maxResponseCharacters: 5_000, restartBudget: 0 });
  try {
    await assert.rejects(() => mcp.callTool('flood', {}), (error: { kind?: string }) => error.kind === 'malformed');
  } finally {
    await mcp.close();
  }
});

test('cancellation rejects the pending request without publishing a result', async () => {
  const mcp = client('ok');
  const controller = new AbortController();
  try {
    const pending = mcp.callTool('slow', {}, controller.signal);
    controller.abort();
    await assert.rejects(() => pending, (error: { kind?: string; message?: string }) => {
      assert.equal(error.kind, 'transport');
      assert.match(String(error.message), /cancel/i);
      return true;
    });
  } finally {
    await mcp.close();
  }
});

test('closing the client removes the child process and blocks further calls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workfolio-mcp-close-'));
  try {
    const mcp = client('ok');
    await mcp.callTool('echo', { query: '닫기 전' });
    await mcp.close();
    await mcp.close();
    await assert.rejects(() => mcp.callTool('echo', { query: '닫은 후' }), (error: { kind?: string }) => error.kind === 'transport');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
