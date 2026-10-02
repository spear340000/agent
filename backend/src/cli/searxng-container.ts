import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ops/searxng');
const envFile = path.join(directory, '.env');
const composeFile = path.join(directory, 'compose.yaml');
const action = process.argv[2] ?? 'up';

if (!['up', 'down', 'status'].includes(action)) {
  console.error('Usage: npm run searxng:<up|down|status>');
  process.exit(2);
}

if (action === 'up' && !existsSync(envFile)) {
  try {
    writeFileSync(envFile, `SEARXNG_SECRET=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

if (action !== 'up' && !existsSync(envFile)) {
  console.log('SearXNG has not been initialized; run npm run searxng:up first.');
  process.exit(0);
}

const arguments_ = ['compose', '--env-file', envFile, '-f', composeFile, ...(action === 'up' ? ['up', '-d'] : action === 'down' ? ['down'] : ['ps'])];
const result = spawnSync('docker', arguments_, { stdio: 'inherit', windowsHide: true });
if (result.error) {
  console.error(`Could not run Docker Compose: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
