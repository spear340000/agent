import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService } from '../src/application/task-service.ts';
import type { ManagedFile } from '../src/domain/managed-file.ts';

test('task creation accepts every source format exposed by the workroom', async () => {
  const formats = [
    ['pdf', 'application/pdf'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['txt', 'text/plain'],
    ['csv', 'application/csv'],
    ['csv', 'text/csv'],
    ['csv', 'text/plain']
  ] as const;
  const files = new Map<string, ManagedFile>(formats.map(([extension, mimeType], index) => [
    `file_${index + 1}`,
    {
      id: `file_${index + 1}`,
      name: `source.${extension}`,
      mimeType,
      bytes: 1,
      createdAt: '2026-09-28T00:00:00.000Z',
      path: `file_${index + 1}`
    }
  ]));
  const supportedFileIds = [...files.keys()];
  let persistedPrompt = '';
  files.set('file_docm', {
    id: 'file_docm',
    name: 'source.docm',
    mimeType: 'application/vnd.ms-word.document.macroEnabled.12',
    bytes: 1,
    createdAt: '2026-09-28T00:00:00.000Z',
    path: 'file_docm'
  });
  const repository = {
    createTask: (prompt: string, title: string | undefined, sourceFileIds: string[], sourceUrls: string[]) => {
      persistedPrompt = prompt;
      return ({
      id: 'task_source_formats',
      prompt,
      title: title ?? prompt,
      sourceFileIds,
      sourceUrls,
      status: 'queued' as const,
      steps: [],
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z'
      });
    }
  };
  const service = new TaskService(
    repository as never,
    { run: async () => undefined } as never,
    { get: async (id: string) => files.get(id) ?? null } as never,
    {} as never
  );

  for (const sourceFileId of supportedFileIds) {
    const task = await service.create({
      prompt: 'Analyze this supported document',
      sourceFileIds: [sourceFileId],
      sourceUrls: ['https://example.com/reference']
    });
    assert.deepEqual(task.sourceFileIds, [sourceFileId]);
    assert.deepEqual(task.sourceUrls, ['https://example.com/reference']);
  }
  const originalPrompt = '  위약금 기준\n\t설명 부탁해요.  ';
  await service.create({ prompt: originalPrompt });
  assert.equal(persistedPrompt, originalPrompt, 'task creation must retain the exact input used as the legal index query');
  await assert.rejects(
    service.create({ prompt: 'Unsupported', sourceFileIds: ['file_docm'] }),
    /unsupported source file/
  );
});
