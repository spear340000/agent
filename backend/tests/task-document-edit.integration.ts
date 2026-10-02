import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DocumentService } from '../src/application/document-service.js';
import { FileService } from '../src/application/file-service.js';
import { TaskService } from '../src/application/task-service.js';
import type { FileStorage, ManagedFile } from '../src/domain/managed-file.js';
import { SqliteTaskRepository } from '../src/infrastructure/persistence/sqlite-task-repository.js';

class MemoryFiles implements FileStorage {
  private readonly files = new Map<string, { metadata: ManagedFile; content: Uint8Array }>();

  async save(input: { name: string; mimeType: string; content: Uint8Array }): Promise<ManagedFile> {
    const id = `file_${this.files.size + 1}`;
    const metadata: ManagedFile = {
      id,
      name: input.name,
      mimeType: input.mimeType,
      bytes: input.content.length,
      createdAt: new Date().toISOString(),
      path: id,
    };
    this.files.set(id, { metadata, content: Uint8Array.from(input.content) });
    return metadata;
  }

  async get(id: string): Promise<ManagedFile | null> {
    return this.files.get(id)?.metadata ?? null;
  }

  async read(id: string): Promise<{ metadata: ManagedFile; content: Uint8Array }> {
    const entry = this.files.get(id);
    if (!entry) throw new Error('file not found');
    return { metadata: entry.metadata, content: Uint8Array.from(entry.content) };
  }
}

test('completed task document edits persist as a new downloadable DOCX artifact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-document-edit-'));
  const files = new MemoryFiles();
  const repository = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  const service = new TaskService(
    repository,
    { run: async () => undefined } as never,
    new FileService(files),
    new DocumentService(files),
  );
  const task = repository.createTask('Write a report');
  repository.updateTask(task.id, { status: 'completed' });

  try {
    const artifact = await service.saveDocument(task.id, '# Revised report\n\nPersist this content.');
    assert.equal(artifact.taskId, task.id);
    assert.equal(artifact.kind, 'document');
    assert.equal(artifact.content, '# Revised report\n\nPersist this content.');
    assert.ok(artifact.fileId);
    assert.ok(Date.parse(repository.getTask(task.id)!.updatedAt) >= Date.parse(artifact.createdAt));
    assert.equal(repository.artifact(artifact.id)?.content, artifact.content);
    const download = await files.read(artifact.fileId!);
    assert.equal(download.metadata.name, 'Write a report.docx');
    assert.ok(Buffer.from(download.content).subarray(0, 2).equals(Buffer.from('PK')));

    repository.close();
    const reopened = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
    try {
      assert.equal(reopened.artifacts(task.id).at(-1)?.content, artifact.content);
      assert.equal(reopened.artifact(artifact.id)?.fileId, artifact.fileId);
    } finally {
      reopened.close();
    }
  } finally {
    try { repository.close(); } catch { /* already closed before reopen check */ }
    await rm(root, { recursive: true, force: true });
  }
});

test('document edits reject unfinished tasks and oversized content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-document-edit-guard-'));
  const files = new MemoryFiles();
  const repository = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  const service = new TaskService(
    repository,
    { run: async () => undefined } as never,
    new FileService(files),
    new DocumentService(files),
  );
  const task = repository.createTask('Still running');

  try {
    await assert.rejects(service.saveDocument(task.id, 'draft'), /only completed tasks/);
    repository.updateTask(task.id, { status: 'completed' });
    await assert.rejects(service.saveDocument(task.id, 'x'.repeat(200_001)), /200000 characters/);
    assert.equal(repository.artifacts(task.id).length, 0);
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('revision reuses the completed task and persists its request and extra sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-revision-'));
  const files = new MemoryFiles();
  const repository = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  const source = await files.save({ name: 'new-source.pdf', mimeType: 'application/pdf', content: Buffer.from('fixture') });
  let runCount = 0;
  const service = new TaskService(
    repository,
    { run: async () => { runCount += 1; } } as never,
    new FileService(files),
    new DocumentService(files),
  );
  const task = repository.createTask('Original request', undefined, [], ['https://example.com/old']);
  repository.updateTask(task.id, { status: 'completed' });

  try {
    const revised = await service.revise(task.id, {
      kind: 'revision',
      message: 'Add a second source and clarify the conclusion.',
      sourceFileIds: [source.id],
      sourceUrls: ['https://example.com/new'],
    });
    assert.equal(revised.id, task.id);
    assert.equal(revised.status, 'queued');
    assert.match(revised.prompt, /Original request[\s\S]*Add a second source/);
    assert.deepEqual(revised.sourceFileIds, [source.id]);
    assert.deepEqual(revised.sourceUrls, ['https://example.com/old', 'https://example.com/new']);
    assert.equal(runCount, 1);
    assert.equal(repository.events(task.id).at(-1)?.type, 'task.revised');
    assert.equal(repository.events(task.id).at(-1)?.metadata?.kind, 'revision');
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});
