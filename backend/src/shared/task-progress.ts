import { AsyncLocalStorage } from 'node:async_hooks';

export type TaskProgress = { title: string; detail: string; items?: string[] };

const store = new AsyncLocalStorage<(progress: TaskProgress) => void>();

/** Lets any stage of one task report what it is doing while it runs; concurrent tasks never share a reporter. */
export function runWithProgress<T>(report: (progress: TaskProgress) => void, work: () => Promise<T>): Promise<T> {
  return store.run(report, work);
}

export function reportProgress(title: string, detail: string, items?: string[]): void {
  try {
    store.getStore()?.({ title, detail, ...(items && items.length > 0 ? { items: items.slice(0, 12) } : {}) });
  } catch {
    // Progress is informational; a failing reporter must never break the task.
  }
}
