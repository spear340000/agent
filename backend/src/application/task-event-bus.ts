import type { TaskEvent } from '../domain/task.js';

export class TaskEventBus {
  private readonly listeners = new Map<string, Set<(event: TaskEvent) => void>>();
  publish(event: TaskEvent): void { for (const listener of this.listeners.get(event.taskId) ?? []) listener(event); }
  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    const group = this.listeners.get(taskId) ?? new Set<(event: TaskEvent) => void>();
    group.add(listener); this.listeners.set(taskId, group);
    return () => { group.delete(listener); if (!group.size) this.listeners.delete(taskId); };
  }
}
