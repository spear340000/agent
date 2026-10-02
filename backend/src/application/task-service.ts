import type { Artifact, Task, TaskDetails } from '../domain/task.js';
import type { TaskRepository } from '../domain/task-repository.js';
import { badRequest, conflict, notFound } from '../shared/app-error.js';
import { AgentService } from './agent-service.js';
import type { DocumentService } from './document-service.js';
import type { FileService } from './file-service.js';

const SUPPORTED_SOURCE_MIME_TYPES: Readonly<Record<string, readonly string[]>> = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  txt: ['text/plain'],
  csv: ['text/csv', 'application/csv', 'text/plain'],
};

export class TaskService {
  constructor(private readonly tasks: TaskRepository, private readonly agent: AgentService, private readonly files: FileService, private readonly documents: DocumentService) {}

  async create(input: { prompt: string; title?: string; sourceFileIds?: string[]; sourceUrls?: string[]; workflow?: 'legal' | 'document' }): Promise<Task> {
    if (!input.prompt.trim()) throw badRequest('prompt is required');
    if (input.prompt.length > 12_000) throw badRequest('prompt must be at most 12000 characters');
    const sourceFileIds = [...new Set(input.sourceFileIds ?? [])];
    if (sourceFileIds.length > 5) throw badRequest('at most 5 source files are allowed');
    const sourceUrls = [...new Set(input.sourceUrls ?? [])];
    if (sourceUrls.length > 5) throw badRequest('at most 5 source URLs are allowed');
    await this.validateSourceFiles(sourceFileIds);
    const task = this.tasks.createTask(input.prompt, input.title?.trim() || undefined, sourceFileIds, sourceUrls, input.workflow);
    void this.agent.run(task.id);
    return task;
  }

  getDetails(id: string): TaskDetails {
    const task = this.tasks.getTask(id);
    if (!task) throw notFound('task not found');
    return { task, events: this.tasks.events(id), artifacts: this.tasks.artifacts(id) };
  }

  list(): Task[] { return this.tasks.listTasks(); }
  rerun(id: string): TaskDetails { const details = this.getDetails(id); if (!['failed', 'queued'].includes(details.task.status)) throw conflict(`cannot rerun a ${details.task.status} task`); void this.agent.run(id); return details; }
  cancel(id: string): TaskDetails { this.agent.cancel(id); return this.getDetails(id); }
  getArtifact(id: string): Artifact { const artifact = this.tasks.artifact(id); if (!artifact) throw notFound('artifact not found'); return artifact; }

  async saveDocument(id: string, markdown: string): Promise<Artifact> {
    const task = this.tasks.getTask(id);
    if (!task) throw notFound('task not found');
    if (task.status !== 'completed') throw conflict('only completed tasks can be edited');
    if (typeof markdown !== 'string' || !markdown.trim()) throw badRequest('document content is required');
    if (markdown.length > 200_000) throw badRequest('document content must not exceed 200000 characters');

    const file = await this.documents.createMarkdownReport({ outputName: task.title, markdown });
    const artifact = this.tasks.addArtifact(id, {
      name: file.name,
      kind: 'document',
      mimeType: file.mimeType,
      content: markdown,
      fileId: file.id,
    });
    this.tasks.updateTask(id, {});
    return artifact;
  }

  async revise(id: string, input: { kind: 'revision' | 'followup'; message: string; sourceFileIds?: string[]; sourceUrls?: string[] }): Promise<Task> {
    const task = this.tasks.getTask(id);
    if (!task) throw notFound('task not found');
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) throw conflict(`cannot revise a ${task.status} task`);
    const message = input.message.trim();
    if (!message || message.length > 12_000) throw badRequest('message must contain 1 to 12000 characters');
    const prompt = `${task.prompt}\n\n${input.kind === 'revision' ? '수정 요청' : '추가 요청'}:\n${message}`;
    if (prompt.length > 12_000) throw badRequest('revised prompt must be at most 12000 characters');

    const sourceFileIds = [...new Set([...task.sourceFileIds, ...(input.sourceFileIds ?? [])])];
    if (sourceFileIds.length > 5) throw badRequest('at most 5 source files are allowed');
    await this.validateSourceFiles(sourceFileIds);
    const sourceUrls = [...new Set([...task.sourceUrls, ...(input.sourceUrls ?? [])])];
    if (sourceUrls.length > 5) throw badRequest('at most 5 source URLs are allowed');

    const next = this.tasks.updateTask(id, {
      prompt,
      sourceFileIds,
      sourceUrls,
      status: 'queued',
      steps: task.steps.map(step => ({ ...step, status: 'pending', progress: 0, error: undefined })),
      error: undefined,
    });
    this.tasks.addEvent(id, {
      type: 'task.revised',
      title: input.kind === 'revision' ? 'Revision requested' : 'Follow-up requested',
      message,
      status: 'queued',
      metadata: { kind: input.kind, message, baseArtifactId: this.tasks.artifacts(id).at(-1)?.id },
    });
    void this.agent.run(id);
    return next;
  }

  private async validateSourceFiles(sourceFileIds: string[]): Promise<void> {
    for (const id of sourceFileIds) {
      const file = await this.files.get(id);
      if (!file) throw badRequest(`source file not found: ${id}`);
      const extension = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase();
      const mimeType = file.mimeType.toLowerCase().split(';', 1)[0]?.trim();
      if (!extension || !SUPPORTED_SOURCE_MIME_TYPES[extension]?.includes(mimeType ?? '')) {
        throw badRequest(`unsupported source file: ${file.name}`);
      }
    }
  }
}
