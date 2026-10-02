import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApiAuthenticator } from '../src/api/authentication.js';
import { ApiRouter } from '../src/api/router.js';
import { errorResponse } from '../src/api/http.js';
import { LocalFileStorage } from '../src/infrastructure/storage/local-file-storage.js';
import { SqliteTaskRepository } from '../src/infrastructure/persistence/sqlite-task-repository.js';

test('managed files and task/artifact references persist; no unsafe file-delete route is exposed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'file-retention-'));
  const storage = new LocalFileStorage(path.join(root, 'files'));
  const repository = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  const file = await storage.save({ name: 'source.txt', mimeType: 'text/plain', content: Buffer.from('preserved') });
  const task = repository.createTask('Keep history', undefined, [file.id], ['https://example.com/reference']);
  const artifact = repository.addArtifact(task.id, { name: 'result.docx', kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: 'report', fileId: file.id });
  const router = new ApiRouter({
    authenticator: new ApiAuthenticator('a'.repeat(32)),
    tasks: { list: () => [] }, browser: {}, computer: {}, capabilities: {}, files: {}, spreadsheets: {}, documents: {}, content: {}, pdfs: {}, redaction: {}, documentAi: {}, eventBus: {},
  } as never);
  const server = http.createServer((req, res) => { void router.handle(req, res).catch(error => errorResponse(res, error)); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/files/${file.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${'a'.repeat(32)}` } });
    assert.equal(response.status, 404);
    repository.close();
    const reopened = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
    assert.deepEqual(reopened.getTask(task.id)?.sourceFileIds, [file.id]);
    assert.deepEqual(reopened.getTask(task.id)?.sourceUrls, ['https://example.com/reference']);
    assert.equal(reopened.artifact(artifact.id)?.fileId, file.id);
    reopened.close();
    assert.equal((await storage.get(file.id))?.id, file.id);
    assert.equal(Buffer.from((await storage.read(file.id)).content).toString(), 'preserved');
    assert.equal(await readFile(path.join(root, 'files', 'index.json'), 'utf8').then(value => value.includes(file.id)), true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try { repository.close(); } catch { /* already closed above */ }
    await rm(root, { recursive: true, force: true });
  }
});
