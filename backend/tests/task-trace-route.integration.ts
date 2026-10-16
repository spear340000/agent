import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiAuthenticator } from '../src/api/authentication.ts';
import { ApiRouter } from '../src/api/router.ts';
import { createApiServer } from '../src/api/server.ts';
import { TaskService } from '../src/application/task-service.ts';
import { TaskEventBus } from '../src/application/task-event-bus.ts';
import { SqliteTaskRepository } from '../src/infrastructure/persistence/sqlite-task-repository.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'agent-trace-route-'));
const repository = new SqliteTaskRepository(path.join(root, 'trace.db'));
const token = 'd'.repeat(32);
const tasks = new TaskService(repository, { run: async () => undefined } as never, { get: async () => null } as never, {} as never);
const router = new ApiRouter({
  tasks,
  eventBus: new TaskEventBus(),
  authenticator: new ApiAuthenticator(token),
  browser: { isAvailable: () => false },
  computer: { isAvailable: () => false },
  files: { read: async () => { throw new Error('unused'); } },
} as never);
const server = createApiServer(router);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
const headers = { authorization: `Bearer ${token}` };

try {
  const task = repository.createTask('민법 제750조');
  repository.addEvent(task.id, { type: 'step.started', title: '근거 기반 답변 작성', message: 'started', status: 'running', metadata: { key: 'legal:write:v2' } } as never);
  repository.addEvent(task.id, { type: 'step.completed', title: '근거 기반 답변 작성', message: 'completed', status: 'completed', metadata: { key: 'legal:write:v2' } } as never);

  const ok = await fetch(`${base}/api/tasks/${task.id}/trace`, { headers });
  assert.equal(ok.status, 200);
  const trace = await ok.json() as { taskId: string; spans: Array<{ kind: string; stage?: string }> };
  assert.equal(trace.taskId, task.id);
  assert.ok(trace.spans.some(span => span.kind === 'step' && span.stage === 'answer'), 'the trace names the stage of a known step');

  const missing = await fetch(`${base}/api/tasks/task_missing/trace`, { headers });
  assert.equal(missing.status, 404, 'an unknown task is reported as not found');

  const unauthenticated = await fetch(`${base}/api/tasks/${task.id}/trace`);
  assert.equal(unauthenticated.status, 401, 'the trace needs the same token as the rest of the API');
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  repository.close();
  await rm(root, { recursive: true, force: true });
}

console.log('task trace route integration tests passed');
