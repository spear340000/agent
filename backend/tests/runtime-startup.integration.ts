import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

// Picks a port that is free right now. Another server in this process can still take it before the child binds it.
async function freePort(): Promise<number> {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => probe.once('listening', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-startup-'));
const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
const serverEntry = path.resolve('backend/src/server.ts');
const dbFile = path.join(root, 'agent.db');

let child: ReturnType<typeof spawn> | undefined;
let childExit: Promise<void> | undefined;
try {
  const baseEnv = { ...process.env, DATABASE_FILE: dbFile, OPENAI_API_KEY: '', COMPUTER_USE_ENABLED: 'false', BROWSER_EXECUTABLE_PATH: '' };
  const missingToken = spawnSync(process.execPath, [tsxCli, serverEntry], { cwd: root, env: { ...baseEnv, PORT: String(await freePort()), API_AUTH_ENABLED: 'true', API_AUTH_TOKEN: '' }, encoding: 'utf8', timeout: 15_000 });
  assert.notEqual(missingToken.status, 0);
  assert.match(`${missingToken.stdout}\n${missingToken.stderr}`, /API_AUTH_TOKEN must be set/);
  assert.equal(existsSync(path.join(root, 'data')), false);

  // The requests below must reach this child. If its port is taken, it exits with EADDRINUSE and the requests would
  // reach the other server, so a port clash is retried on a new port instead.
  let base = '';
  for (let attempt = 1; ; attempt++) {
    base = `http://127.0.0.1:${await freePort()}`;
    child = spawn(process.execPath, [tsxCli, serverEntry], { cwd: root, env: { ...baseEnv, PORT: new URL(base).port, API_AUTH_ENABLED: 'false', API_AUTH_TOKEN: 'legacy-configured-token-that-is-not-required' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    // Wait for stdio and any inherited handles to close, not merely the process exit event.
    const exited = new Promise<void>(resolve => child!.once('close', () => resolve()));
    childExit = exited;
    const started = new Promise<void>((resolve, reject) => {
      child!.stdout.on('data', data => { output += data.toString(); if (output.includes(`listening on ${base}`)) resolve(); });
      child!.stderr.on('data', data => { output += data.toString(); });
      child!.once('exit', code => reject(new Error(`backend exited before listening (${code}): ${output}`)));
    });
    try {
      await withTimeout(started, 15_000, `backend startup timed out: ${output}`);
      break;
    } catch (error) {
      if (attempt === 3 || !output.includes('EADDRINUSE')) throw error;
      await exited;
      child = undefined;
    }
  }
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/tasks`)).status, 200, 'local API should work without a bearer token by default');
  const allowedOrigin = await fetch(`${base}/api/tasks`, { headers: { origin: 'http://localhost:3001' } });
  assert.equal(allowedOrigin.status, 200);
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), 'http://localhost:3001');
  assert.equal((await fetch(`${base}/api/tasks`, { headers: { origin: 'http://evil.example' } })).status, 403, 'origin restrictions must remain active without bearer authentication');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    try { await withTimeout(childExit!, 5_000, 'backend shutdown timed out'); }
    catch { child.kill('SIGKILL'); await withTimeout(childExit!, 2_000, 'backend process could not be terminated'); }
  }
  await rm(root, { recursive: true, force: true });
}

console.log('runtime startup integration tests passed');
