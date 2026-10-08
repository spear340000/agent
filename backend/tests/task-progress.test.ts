import assert from 'node:assert/strict';
import test from 'node:test';
import { reportProgress, runWithProgress, type TaskProgress } from '../src/shared/task-progress.ts';

test('progress reports reach only the task that is running them', async () => {
  const first: TaskProgress[] = [];
  const second: TaskProgress[] = [];
  await Promise.all([
    runWithProgress(progress => first.push(progress), async () => {
      reportProgress('a', 'first');
      await new Promise(resolve => setTimeout(resolve, 5));
      reportProgress('b', 'first', ['x']);
    }),
    runWithProgress(progress => second.push(progress), async () => {
      await new Promise(resolve => setTimeout(resolve, 2));
      reportProgress('c', 'second');
    })
  ]);
  assert.deepEqual(first.map(item => item.title), ['a', 'b']);
  assert.deepEqual(first[1]!.items, ['x']);
  assert.deepEqual(second.map(item => item.title), ['c']);
  reportProgress('outside', 'no reporter is a no-op');
});

test('a failing reporter never breaks the task', async () => {
  await runWithProgress(() => { throw new Error('reporter down'); }, async () => {
    reportProgress('still fine', 'x');
  });
});
