import type { Artifact, Task, TaskEvent, TaskWorkflow } from './task.js';

export interface TaskRepository {
  createTask(prompt: string, title?: string, sourceFileIds?: string[], sourceUrls?: string[], workflow?: TaskWorkflow): Task;
  getTask(id: string): Task | null;
  listTasks(limit?: number): Task[];
  updateTask(id: string, patch: Partial<Task>): Task;
  transitionTask(id: string, expected: Task['status'][], patch: Partial<Task>): Task | null;
  addEvent(taskId: string, event: Omit<TaskEvent, 'id' | 'taskId' | 'createdAt'>): TaskEvent;
  events(taskId: string, limit?: number): TaskEvent[];
  addArtifact(taskId: string, artifact: Omit<Artifact, 'id' | 'taskId' | 'createdAt'>): Artifact;
  artifacts(taskId: string, limit?: number): Artifact[];
  artifact(id: string): Artifact | null;
  setCheckpoint(taskId: string, key: string, value: unknown): void;
  getCheckpoint<T>(taskId: string, key: string): T | null;
  close(): void;
}
