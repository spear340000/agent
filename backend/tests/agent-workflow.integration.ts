import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { SqliteTaskRepository } from '../src/infrastructure/persistence/sqlite-task-repository.js';
import { AgentService } from '../src/application/agent-service.js';
import { FileService } from '../src/application/file-service.js';
import { TaskService } from '../src/application/task-service.js';
import { DocumentService } from '../src/application/document-service.js';
import { DocumentContentService } from '../src/application/document-content-service.js';
import { TaskEventBus } from '../src/application/task-event-bus.js';
import type { FileStorage, ManagedFile } from '../src/domain/managed-file.js';
import type { ModelProvider } from '../src/domain/model-provider.js';
import type { WebSource } from '../src/tools/browser-use.js';

class MemoryFiles implements FileStorage {
  private readonly entries = new Map<string, { metadata: ManagedFile; content: Uint8Array }>();
  async save(input: { name: string; mimeType: string; content: Uint8Array }): Promise<ManagedFile> {
    const id = `file_${this.entries.size + 1}`;
    const metadata = { id, name: input.name, mimeType: input.mimeType, bytes: input.content.length, createdAt: new Date().toISOString(), path: id };
    this.entries.set(id, { metadata, content: Uint8Array.from(input.content) });
    return metadata;
  }
  async get(id: string): Promise<ManagedFile | null> { return this.entries.get(id)?.metadata ?? null; }
  async read(id: string): Promise<{ metadata: ManagedFile; content: Uint8Array }> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('file not found');
    return { metadata: entry.metadata, content: Uint8Array.from(entry.content) };
  }
}

test('source-only work completes without contacting an unavailable search service', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workfolio-source-only-'));
  const files = new MemoryFiles();
  const tasks = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  const source = await files.save({ name: '회의록.txt', mimeType: 'text/plain', content: Buffer.from('회의 결론: 다음 주에 출시한다.') });
  const model: ModelProvider = { complete: async ({ system }) => system.startsWith('Return only valid JSON')
    ? JSON.stringify({ title: '회의 요약', searchQueries: [], outline: [] })
    : system.startsWith('Analyze the user request') ? '다음 주 출시 [TXT1].' : '# 회의 요약\n\n다음 주 출시 [TXT1].' };
  const agent = new AgentService(tasks, model, { searchMany: async () => { throw new Error('search is offline'); } } as never, new DocumentContentService(files), new DocumentService(files), new TaskEventBus());
  try {
    const task = tasks.createTask('첨부 회의록만 요약해 주세요.', undefined, [source.id]);
    await agent.run(task.id);
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.match(tasks.artifacts(task.id)[0]?.content ?? '', /다음 주 출시/);
  } finally { await agent.drain(); tasks.close(); await rm(root, { recursive: true, force: true }); }
});

test('revision uses the latest manually saved document as editing context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workfolio-revision-base-'));
  const files = new MemoryFiles();
  const tasks = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  const model: ModelProvider = { complete: async ({ system, user }) => system.startsWith('Return only valid JSON')
    ? JSON.stringify({ title: '계획', searchQueries: [], outline: [] })
    : system.startsWith('Analyze the user request') ? user : `# 계획\n\n${user.includes('수동 수정: 담당자는 김민수') ? '담당자는 김민수입니다. 결론을 추가했습니다.' : '초안입니다.'}` };
  const documents = new DocumentService(files);
  const agent = new AgentService(tasks, model, { searchMany: async () => [] } as never, new DocumentContentService(files), documents, new TaskEventBus());
  const service = new TaskService(tasks, agent, new FileService(files), documents);
  try {
    const task = await service.create({ prompt: '일정 계획 초안을 써 주세요.' });
    await agent.drain();
    const saved = await service.saveDocument(task.id, '# 일정\n\n수동 수정: 담당자는 김민수');
    await service.revise(task.id, { kind: 'revision', message: '담당자를 유지하고 결론을 추가해 주세요.' });
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.match(tasks.artifacts(task.id).at(-1)?.content ?? '', /담당자는 김민수/);
    assert.equal(tasks.events(task.id).find(event => event.type === 'task.revised')?.metadata?.baseArtifactId, saved.id);
  } finally { await agent.drain(); tasks.close(); await rm(root, { recursive: true, force: true }); }
});

test('offline task creation runs research through a cited downloadable DOCX and replays persisted events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-workflow-'));
  const files = new MemoryFiles();
  let tasks = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  const bus = new TaskEventBus();
  const calls: string[] = [];
  const model: ModelProvider = { complete: async ({ system, user }) => {
    calls.push(system);
    if (system.startsWith('Return only valid JSON')) return JSON.stringify({ title: 'Local workflow', searchQueries: ['bounded test'], outline: ['Finding'] });
    if (system.startsWith('Analyze the user request')) return 'The uploaded document and web source support [PDF1] and [W1].';
    return user.includes('Add an updated conclusion')
      ? '# Updated findings\n\nRevised and verified [PDF1] [W1].'
      : '# Findings\n\nVerified finding [PDF1] [W1].';
  } };
  const source: WebSource = { title: 'Controlled source', url: 'https://example.com/report', snippet: 'verified', content: 'A deterministic local fixture.', retrievedAt: new Date().toISOString(), retrievalStatus: 'retrieved' };
  const browser = { searchMany: async () => [source] };
  const documents = new DocumentService(files);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  page.drawText('A deterministic uploaded report.', { font: await pdf.embedFont(StandardFonts.Helvetica), x: 48, y: 700 });
  const uploaded = await new FileService(files).uploadBase64({ name: 'source.pdf', mimeType: 'application/pdf', base64: Buffer.from(await pdf.save()).toString('base64') });
  const task = tasks.createTask('Summarize the controlled source and uploaded report.', undefined, [uploaded.id]);
  tasks.setCheckpoint(task.id, 'plan', { version: 1, inputFingerprint: 'stale-input-fingerprint', value: { title: 'Stale title', searchQueries: [], outline: [] } });
  tasks.close();
  tasks = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  const agent = new AgentService(tasks, model, browser as never, new DocumentContentService(files), documents, bus);
  try {
    agent.resumePending();
    const duplicateRun = agent.run(task.id);
    await duplicateRun;
    await agent.drain();
    const details = { task: tasks.getTask(task.id)!, events: tasks.events(task.id), artifacts: tasks.artifacts(task.id) };
    assert.equal(details.task.status, 'completed');
    assert.deepEqual(details.task.sourceFileIds, [uploaded.id]);
    assert.equal(details.artifacts.length, 1);
    assert.match(details.artifacts[0]!.content, /Verified finding \[PDF1\] \[W1\]/);
    assert.match(details.artifacts[0]!.fileId ?? '', /^file_/);
    const saved = await files.read(details.artifacts[0]!.fileId!);
    assert.equal(saved.metadata.name, 'Local workflow.docx');
    assert.ok(Buffer.from(saved.content).subarray(0, 2).equals(Buffer.from('PK')));
    assert.ok(details.events.some(event => event.type === 'task.completed'));
    assert.deepEqual(details.events.map(event => event.type).filter(type => type === 'task.completed'), ['task.completed']);
    assert.equal(details.events.filter(event => event.type === 'step.completed').length, 5);
    assert.equal(calls.length, 3, 'stale plan checkpoint must be recomputed');

    const taskService = new TaskService(tasks, agent, new FileService(files), documents);
    const revised = await taskService.revise(task.id, {
      kind: 'revision',
      message: 'Add an updated conclusion.',
      sourceFileIds: [uploaded.id],
    });
    assert.equal(revised.id, task.id, 'revision must stay in the same task history');
    await agent.drain();
    const revisedDetails = { task: tasks.getTask(task.id)!, events: tasks.events(task.id), artifacts: tasks.artifacts(task.id) };
    assert.equal(revisedDetails.task.status, 'completed');
    assert.match(revisedDetails.task.prompt, /Add an updated conclusion/);
    assert.equal(revisedDetails.artifacts.length, 2, 'the first artifact remains in version history');
    assert.match(revisedDetails.artifacts.at(-1)!.content, /Revised and verified/);
    assert.equal(revisedDetails.events.filter(event => event.type === 'task.revised').length, 1);
    assert.equal(revisedDetails.events.filter(event => event.type === 'task.completed').length, 2);
    assert.equal(calls.length, 6, 'prompt-dependent checkpoints are recomputed for the revision');
  } finally {
    tasks.close(); await rm(root, { recursive: true, force: true });
  }
});

test('user-provided public URLs are visited and included as citable report sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-direct-url-'));
  const files = new MemoryFiles();
  const tasks = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  const requestedUrls: string[] = [];
  const model: ModelProvider = {
    complete: async ({ system }) => system.startsWith('Return only valid JSON')
      ? JSON.stringify({ title: 'Direct source report', searchQueries: [], outline: [] })
      : system.startsWith('Analyze the user request')
        ? 'The supplied page states the report finding [W1].'
        : '# Findings\n\nThe supplied page states the report finding [W1].',
  };
  const page: WebSource = {
    title: 'User-provided page',
    url: 'https://example.com/report',
    snippet: 'Report excerpt',
    content: 'A verified user-provided report page.',
    retrievedAt: new Date().toISOString(),
    retrievalStatus: 'retrieved',
  };
  const browser = {
    searchMany: async () => [],
    visitMany: async (urls: string[]) => { requestedUrls.push(...urls); return [page]; },
  };
  const agent = new AgentService(tasks, model, browser as never, new DocumentContentService(files), new DocumentService(files), new TaskEventBus());
  const task = tasks.createTask('Summarize this supplied page.', undefined, [], ['https://example.com/report']);

  try {
    await agent.run(task.id);
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.deepEqual(requestedUrls, ['https://example.com/report']);
    assert.match(tasks.artifacts(task.id)[0]?.content ?? '', /\[W1\]/);
  } finally { tasks.close(); await rm(root, { recursive: true, force: true }); }
});

test('citation repair rejects a second response that still contains invalid IDs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-citation-'));
  const files = new MemoryFiles();
  const tasks = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  let rejectCitations = true;
  let analysisCalls = 0;
  const model: ModelProvider = { complete: async ({ system }) => system.startsWith('Return only valid JSON')
    ? JSON.stringify({ title: 'Report', searchQueries: ['query'], outline: [] })
    : system.startsWith('Analyze the user request') ? (analysisCalls += 1, 'Evidence [W1].')
      : rejectCitations ? 'Unsupported citation [W99].' : '# Findings\n\nEvidence [W1].' };
  const browser = { searchMany: async () => [{ title: 'Source', url: 'https://example.com/', snippet: '', content: 'Evidence', retrievedAt: new Date().toISOString(), retrievalStatus: 'retrieved' }] };
  const agent = new AgentService(tasks, model, browser as never, new DocumentContentService(files), new DocumentService(files), new TaskEventBus());
  const task = tasks.createTask('Question');
  try {
    await agent.run(task.id);
    assert.equal(tasks.getTask(task.id)?.status, 'failed');
    assert.match(tasks.getTask(task.id)?.error ?? '', /citations failed validation/);
    assert.equal(tasks.artifacts(task.id).length, 0);
    rejectCitations = false;
    await agent.run(task.id);
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.equal(tasks.artifacts(task.id).length, 1);
    assert.equal(analysisCalls, 1, 'completed analysis checkpoint should be reused on retry');
  } finally { tasks.close(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling a task waiting for a concurrency slot prevents it from reaching the model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-queue-cancel-'));
  const files = new MemoryFiles();
  const tasks = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  let planCalls = 0;
  const model: ModelProvider = { complete: async ({ system }) => {
    if (system.startsWith('Return only valid JSON')) { planCalls += 1; await gate; return JSON.stringify({ title: 'Report', searchQueries: [], outline: [] }); }
    if (system.startsWith('Analyze the user request')) return 'No source was supplied.';
    return 'No evidence available.';
  } };
  const agent = new AgentService(tasks, model, { searchMany: async () => [] } as never, new DocumentContentService(files), new DocumentService(files), new TaskEventBus());
  const first = tasks.createTask('first'); const second = tasks.createTask('second'); const third = tasks.createTask('third');
  try {
    const running = [agent.run(first.id), agent.run(second.id)];
    while (planCalls < 2) await new Promise(resolve => setTimeout(resolve, 1));
    const waiting = agent.run(third.id);
    agent.cancel(third.id);
    await waiting;
    unblock();
    await Promise.all(running);
    assert.equal(tasks.getTask(third.id)?.status, 'cancelled');
    assert.equal(planCalls, 2);
    assert.throws(() => agent.cancel(first.id), /cannot cancel a completed/);
  } finally { unblock(); await agent.drain(); tasks.close(); await rm(root, { recursive: true, force: true }); }
});

test('cancellation wins while final model output is pending and prevents artifact publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cancel-final-'));
  const files = new MemoryFiles();
  const tasks = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  let enteredDraft!: () => void;
  let resolveDraft!: (value: string) => void;
  const draftStarted = new Promise<void>(resolve => { enteredDraft = resolve; });
  const draft = new Promise<string>(resolve => { resolveDraft = resolve; });
  const model: ModelProvider = { complete: async ({ system }) => {
    if (system.startsWith('Return only valid JSON')) return JSON.stringify({ title: 'Report', searchQueries: [], outline: [] });
    if (system.startsWith('Analyze the user request')) return 'No source was supplied.';
    enteredDraft(); return draft;
  } };
  const agent = new AgentService(tasks, model, { searchMany: async () => [] } as never, new DocumentContentService(files), new DocumentService(files), new TaskEventBus());
  const task = tasks.createTask('Question');
  try {
    const running = agent.run(task.id);
    await draftStarted;
    agent.cancel(task.id);
    resolveDraft('No evidence available.');
    await running;
    assert.equal(tasks.getTask(task.id)?.status, 'cancelled');
    assert.equal(tasks.artifacts(task.id).length, 0);
  } finally { resolveDraft('No evidence available.'); await agent.drain(); tasks.close(); await rm(root, { recursive: true, force: true }); }
});
