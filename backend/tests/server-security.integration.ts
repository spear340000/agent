import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiAuthenticator } from '../src/api/authentication.ts';
import { ApiRouter } from '../src/api/router.ts';
import { createApiServer } from '../src/api/server.ts';
import { createServerShutdown } from '../src/server-lifecycle.ts';
import { TaskService } from '../src/application/task-service.ts';
import { TaskEventBus } from '../src/application/task-event-bus.ts';
import { SqliteTaskRepository } from '../src/infrastructure/persistence/sqlite-task-repository.ts';

const shutdownCalls: string[] = [];
let notifyClosed: ((error?: Error) => void) | undefined;
const shutdown = createServerShutdown({
  stopAccepting: callback => { shutdownCalls.push('stop'); notifyClosed = callback; },
  closeConnections: () => { shutdownCalls.push('connections'); },
  closeConfirmation: async () => { shutdownCalls.push('confirmation'); },
  drainAgent: async () => { shutdownCalls.push('agent'); },
  closeBrowsers: async () => { shutdownCalls.push('browsers'); },
  closePersistence: () => { shutdownCalls.push('database'); },
});
const shutdownA = shutdown();
const shutdownB = shutdown();
assert.strictEqual(shutdownA, shutdownB);
await new Promise(resolve => setImmediate(resolve));
notifyClosed?.();
await shutdownA;
assert.deepEqual(shutdownCalls, ['confirmation', 'stop', 'connections', 'agent', 'browsers', 'database']);

const root = await mkdtemp(path.join(os.tmpdir(), 'agent-api-security-'));
const repository = new SqliteTaskRepository(path.join(root, 'api-test.db'));
let fileReads = 0;
const token = 'c'.repeat(32);
const authenticator = new ApiAuthenticator(token);
const taskService = new TaskService(repository, { run: async () => undefined } as never, { get: async () => null } as never, {
  createMarkdownReport: async ({ outputName, markdown }: { outputName: string; markdown: string }) => ({
    id: 'file_edited_doc', name: `${outputName}.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: markdown.length, createdAt: new Date().toISOString(), path: 'private',
  }),
} as never);
const router = new ApiRouter({
  tasks: taskService,
  eventBus: new TaskEventBus(),
  authenticator,
  browser: { isAvailable: () => false },
  computer: { isAvailable: () => false },
  files: { read: async () => { fileReads++; return { metadata: { name: 'output.txt', mimeType: 'text/plain' }, content: Buffer.from('safe') }; } },
} as never);
const server = createApiServer(router);
server.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

try {
  assert.equal((await fetch(`${base}/api/files/file_1/content`)).status, 401);
  assert.equal(fileReads, 0);
  assert.equal((await fetch(`${base}/api/tasks/task_1/events`)).status, 401);

  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const createdResponse = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'integration test task' }) });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json() as { task: { id: string } };
  assert.ok(created.task.id.startsWith('task_'));
  assert.equal((await fetch(`${base}/api/tasks`, { headers: { authorization: `Bearer ${token}` } })).status, 200);

  const editableTask = repository.createTask('Editable report');
  repository.updateTask(editableTask.id, { status: 'completed' });
  const unauthenticatedEdit = await fetch(`${base}/api/tasks/${editableTask.id}/document`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown: '# Revised' }),
  });
  assert.equal(unauthenticatedEdit.status, 401);
  const editResponse = await fetch(`${base}/api/tasks/${editableTask.id}/document`, {
    method: 'POST', headers, body: JSON.stringify({ markdown: '# Revised report' }),
  });
  assert.equal(editResponse.status, 201);
  const editBody = await editResponse.json() as { artifact: { content: string; fileId?: string } };
  assert.equal(editBody.artifact.content, '# Revised report');
  assert.equal(editBody.artifact.fileId, 'file_edited_doc');
  const revisionResponse = await fetch(`${base}/api/tasks/${editableTask.id}/revise`, {
    method: 'POST', headers, body: JSON.stringify({ kind: 'revision', message: 'Add one more detail.' }),
  });
  assert.equal(revisionResponse.status, 202);
  const revisionBody = await revisionResponse.json() as { task: { id: string; prompt: string; status: string } };
  assert.equal(revisionBody.task.id, editableTask.id);
  assert.equal(revisionBody.task.status, 'queued');
  assert.match(revisionBody.task.prompt, /Add one more detail/);

  const fileResponse = await fetch(`${base}/api/files/file_1/content`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(fileResponse.status, 200);
  assert.equal(await fileResponse.text(), 'safe');
  assert.equal(fileReads, 1);

  const eventController = new AbortController();
  const events = await fetch(`${base}/api/tasks/${created.task.id}/events`, { headers: { authorization: `Bearer ${token}` }, signal: eventController.signal });
  assert.equal(events.status, 200);
  await events.body?.cancel();
  eventController.abort();
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  repository.close();
  await rm(root, { recursive: true, force: true });
}

console.log('server security integration tests passed');
