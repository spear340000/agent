import assert from 'node:assert/strict';
import test from 'node:test';
import { taskInput, taskRevisionInput } from '../src/api/contracts.ts';

test('task input preserves bounded HTTP(S) source URLs', () => {
  assert.deepEqual(
    taskInput({ prompt: 'Summarize', sourceUrls: ['https://example.com/report'] }).sourceUrls,
    ['https://example.com/report']
  );
  assert.throws(
    () => taskInput({ prompt: 'Summarize', sourceUrls: ['javascript:alert(1)'] }),
    /sourceUrls must contain valid HTTP\(S\) URLs/
  );
  assert.throws(
    () => taskInput({ prompt: 'Summarize', sourceUrls: Array(6).fill('https://example.com') }),
    /at most 5 source URLs/
  );
});

test('task revision input validates follow-up text and optional additional sources', () => {
  assert.deepEqual(taskRevisionInput({
    kind: 'revision',
    message: '  Add the latest figures.  ',
    sourceFileIds: ['file_1'],
    sourceUrls: ['https://example.com/latest'],
  }), {
    kind: 'revision',
    message: 'Add the latest figures.',
    sourceFileIds: ['file_1'],
    sourceUrls: ['https://example.com/latest'],
  });
  assert.throws(() => taskRevisionInput({ kind: 'revision', message: ' ' }), /message must contain/);
  assert.throws(() => taskRevisionInput({ kind: 'other', message: 'Update' }), /kind must be/);
  assert.throws(() => taskRevisionInput({ kind: 'followup', message: 'Update', sourceUrls: ['http://user:pass@example.com'] }), /valid HTTP\(S\) URLs/);
});
