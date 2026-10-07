import { AsyncLocalStorage } from 'node:async_hooks';

export type ModelAttempt = { model: string; ok: boolean; ms: number; error?: string };

const store = new AsyncLocalStorage<ModelAttempt[]>();

/** Records, per task, which model answered or failed; concurrent tasks never share a list. */
export function runWithModelAttempts<T>(attempts: ModelAttempt[], work: () => Promise<T>): Promise<T> {
  return store.run(attempts, work);
}

export function recordModelAttempt(attempt: ModelAttempt): void {
  store.getStore()?.push(attempt);
}

export function summarizeModelAttempts(attempts: readonly ModelAttempt[]): { finalModel: string | null; fellBack: boolean; failedModels: string[] } {
  const failedModels = [...new Set(attempts.filter(attempt => !attempt.ok).map(attempt => attempt.model))];
  const finalModel = [...attempts].reverse().find(attempt => attempt.ok)?.model ?? null;
  return { finalModel, fellBack: failedModels.length > 0, failedModels };
}
