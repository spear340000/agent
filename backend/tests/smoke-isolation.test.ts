import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'agent-smoke-isolation-'));
const sentinelDb = path.join(sandbox, 'data', 'test.db');
const sentinelFile = path.join(sandbox, 'data', 'test-files', 'keep.txt');
await mkdir(path.dirname(sentinelFile), { recursive: true });
await writeFile(sentinelDb, 'preserve-db');
await writeFile(sentinelFile, 'preserve-file');

try {
  execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('backend/tests/smoke.ts')], { cwd: sandbox, timeout: 60_000, stdio: 'pipe' });
  assert.equal(await readFile(sentinelDb, 'utf8'), 'preserve-db');
  assert.equal(await readFile(sentinelFile, 'utf8'), 'preserve-file');
} finally { await rm(sandbox, { recursive: true, force: true }); }

console.log('smoke test isolation passed');
