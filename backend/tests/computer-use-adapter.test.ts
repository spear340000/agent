import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ComputerUseService } from '../src/tools/computer-use.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'computer-use-adapter-'));
const commands: string[] = [];
const mockPowerShell = async (_executable: string, script: string): Promise<void> => {
  commands.push(script);
  const pathMatch = /try\{\$b\.Save\('(.+?)',/.exec(script);
  if (pathMatch) await writeFile(pathMatch[1]!.replace(/\\\\/g, '\\'), Buffer.from('PNG'));
};

try {
  const service = new ComputerUseService({ enabled: true, platform: 'win32', tempDirectory: root, powershellPath: 'test-powershell', runPowerShell: mockPowerShell });
  assert.equal(service.isAvailable(), true);
  assert.deepEqual(await service.perform({ kind: 'type', text: 'literal + text' }), { kind: 'type', executed: true });
  assert.match(commands[0]!, /FromBase64String/);
  assert.deepEqual(await readdir(root), [], 'typing must not create screenshot files');
  const screenshot = await service.perform({ kind: 'screenshot' });
  assert.equal(screenshot.screenshotBase64, Buffer.from('PNG').toString('base64'));
  assert.deepEqual(await readdir(root), [], 'temporary screenshot files must be removed');

  const bounded = new ComputerUseService({ enabled: true, platform: 'win32', tempDirectory: root, maxScreenshotBytes: 2, runPowerShell: mockPowerShell });
  await assert.rejects(bounded.perform({ kind: 'screenshot' }), /screenshot exceeds the configured byte limit/);
  assert.deepEqual(await readdir(root), [], 'oversized screenshots must also be removed');

  const failed = new ComputerUseService({ enabled: true, platform: 'win32', tempDirectory: root, runPowerShell: async () => { throw new Error('PowerShell failed'); } });
  await assert.rejects(failed.perform({ kind: 'screenshot' }), /PowerShell failed/);
  assert.deepEqual(await readdir(root), [], 'failed actions must leave no screenshot behind');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('computer use adapter tests passed');
