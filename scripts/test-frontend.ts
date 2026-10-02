import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function testsIn(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await testsIn(target));
    else if (/\.test\.tsx?$/.test(item.name)) files.push(target);
  }
  return files;
}

const files = (await testsIn(path.join(root, 'src'))).sort();
if (!files.length) throw new Error('No frontend tests found');

const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
