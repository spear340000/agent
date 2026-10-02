import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = await mkdtemp(path.join(os.tmpdir(), 'dotenv-test-isolation-'));
const sentinel = `CODEX_TEST_DOTENV_${process.pid}_${Date.now()}`;
const envModule = fileURLToPath(import.meta.resolve('../src/config/env.ts'));
const tsxLoader = import.meta.resolve('tsx');

try {
  await writeFile(path.join(root, '.env'), `${sentinel}=should-not-load\n`);
  const code = `await import(${JSON.stringify(pathToFileURL(envModule).href)});process.stdout.write(process.env[${JSON.stringify(sentinel)}] ?? 'unset')`;
  const child = spawnSync(process.execPath, ['--import', tsxLoader, '--eval', code], {
    cwd: root,
    env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'unset', 'test-mode config must not load a .env file');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('dotenv test isolation passed');
