import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Artifact, Task, TaskEvent, TaskWorkflow } from '../../domain/task.js';
import type { TaskRepository } from '../../domain/task-repository.js';
import { notFound } from '../../shared/app-error.js';

type TaskRow = { id: string; title: string; prompt: string; status: Task['status']; steps_json: string; error: string | null; created_at: string; updated_at: string; source_files_json?: string; source_urls_json?: string; workflow_json?: string | null };
type ArtifactRow = { id: string; task_id: string; name: string; kind: Artifact['kind']; mime_type: string; content: string; created_at: string; file_id: string | null };

export class SqliteTaskRepository implements TaskRepository {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, steps_json TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_files_json TEXT NOT NULL DEFAULT '[]', source_urls_json TEXT NOT NULL DEFAULT '[]', workflow_json TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, metadata_json TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, mime_type TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, file_id TEXT);
      CREATE TABLE IF NOT EXISTS task_checkpoints (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_id,key));`);
    for (const sql of ["ALTER TABLE tasks ADD COLUMN source_files_json TEXT NOT NULL DEFAULT '[]'", "ALTER TABLE tasks ADD COLUMN source_urls_json TEXT NOT NULL DEFAULT '[]'", 'ALTER TABLE artifacts ADD COLUMN file_id TEXT', 'ALTER TABLE tasks ADD COLUMN workflow_json TEXT']) {
      try { this.db.exec(sql); } catch (error) { if (!(error instanceof Error) || !error.message.includes('duplicate column name')) throw error; }
    }
  }
  createTask(prompt: string, title?: string, sourceFileIds: string[] = [], sourceUrls: string[] = [], workflow?: TaskWorkflow): Task {
    const now = new Date().toISOString();
    const task: Task = { id: `task_${randomUUID()}`, title: title || prompt.slice(0, 80), prompt, sourceFileIds, sourceUrls, status: 'queued', steps: [], createdAt: now, updatedAt: now, ...(workflow ? { workflow } : {}) };
    this.db.prepare('INSERT INTO tasks(id,title,prompt,status,steps_json,error,created_at,updated_at,source_files_json,source_urls_json,workflow_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(task.id, task.title, task.prompt, task.status, '[]', null, now, now, JSON.stringify(sourceFileIds), JSON.stringify(sourceUrls), task.workflow ?? null);
    return task;
  }
  getTask(id: string): Task | null { const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | undefined; return row ? this.mapTask(row) : null; }
  listTasks(limit = 100): Task[] { return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as TaskRow[]).map(row => this.mapTask(row)); }
  updateTask(id: string, patch: Partial<Task>): Task {
    const task = this.getTask(id); if (!task) throw notFound('task not found');
    const next = { ...task, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE tasks SET title=?,prompt=?,status=?,steps_json=?,error=?,updated_at=?,source_files_json=?,source_urls_json=?,workflow_json=? WHERE id=?').run(next.title, next.prompt, next.status, JSON.stringify(next.steps), next.error ?? null, next.updatedAt, JSON.stringify(next.sourceFileIds), JSON.stringify(next.sourceUrls), next.workflow ?? null, id);
    return next;
  }
  transitionTask(id: string, expected: Task['status'][], patch: Partial<Task>): Task | null {
    const current = this.getTask(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    const allowed = [...new Set(expected)];
    if (!allowed.length) return null;
    const placeholders = allowed.map(() => '?').join(',');
    const result = this.db.prepare(`UPDATE tasks SET title=?,prompt=?,status=?,steps_json=?,error=?,updated_at=?,source_files_json=?,source_urls_json=?,workflow_json=? WHERE id=? AND status IN (${placeholders})`)
      .run(next.title, next.prompt, next.status, JSON.stringify(next.steps), next.error ?? null, next.updatedAt, JSON.stringify(next.sourceFileIds), JSON.stringify(next.sourceUrls), next.workflow ?? null, id, ...allowed);
    return Number(result.changes) === 1 ? this.getTask(id) : null;
  }
  addEvent(taskId: string, event: Omit<TaskEvent, 'id' | 'taskId' | 'createdAt'>): TaskEvent {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(task_id,type,title,message,status,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)').run(taskId, event.type, event.title, event.message, event.status, event.metadata ? JSON.stringify(event.metadata) : null, createdAt);
    return { id: Number(result.lastInsertRowid), taskId, createdAt, ...event };
  }
  events(taskId: string, limit = 100): TaskEvent[] { return (this.db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY id DESC LIMIT ?').all(taskId, limit) as any[]).reverse().map(row => ({ id: row.id, taskId, type: row.type, title: row.title, message: row.message, status: row.status, createdAt: row.created_at, metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined })); }
  addArtifact(taskId: string, artifact: Omit<Artifact, 'id' | 'taskId' | 'createdAt'>): Artifact {
    const output: Artifact = { id: `artifact_${randomUUID()}`, taskId, createdAt: new Date().toISOString(), ...artifact };
    this.db.prepare('INSERT INTO artifacts(id,task_id,name,kind,mime_type,content,created_at,file_id) VALUES(?,?,?,?,?,?,?,?)').run(output.id, output.taskId, output.name, output.kind, output.mimeType, output.content, output.createdAt, output.fileId ?? null);
    return output;
  }
  artifacts(taskId: string, limit = 100): Artifact[] { return (this.db.prepare('SELECT * FROM artifacts WHERE task_id=? ORDER BY rowid DESC LIMIT ?').all(taskId, limit) as ArtifactRow[]).reverse().map(row => this.mapArtifact(row)); }
  artifact(id: string): Artifact | null { const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as ArtifactRow | undefined; return row ? this.mapArtifact(row) : null; }
  setCheckpoint(taskId: string, key: string, value: unknown): void { this.db.prepare('INSERT INTO task_checkpoints(task_id,key,value_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(task_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(taskId, key, JSON.stringify(value), new Date().toISOString()); }
  getCheckpoint<T>(taskId: string, key: string): T | null { const row = this.db.prepare('SELECT value_json FROM task_checkpoints WHERE task_id=? AND key=?').get(taskId, key) as { value_json: string } | undefined; return row ? JSON.parse(row.value_json) as T : null; }
  close(): void { this.db.close(); }
  private mapTask(row: TaskRow): Task { const workflow = row.workflow_json === 'legal' || row.workflow_json === 'document' ? row.workflow_json : undefined; return { id: row.id, title: row.title, prompt: row.prompt, sourceFileIds: JSON.parse(row.source_files_json ?? '[]'), sourceUrls: JSON.parse(row.source_urls_json ?? '[]'), status: row.status, steps: JSON.parse(row.steps_json), ...(workflow ? { workflow } : {}), error: row.error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private mapArtifact(row: ArtifactRow): Artifact { return { id: row.id, taskId: row.task_id, name: row.name, kind: row.kind, mimeType: row.mime_type, content: row.content, fileId: row.file_id ?? undefined, createdAt: row.created_at }; }
}
