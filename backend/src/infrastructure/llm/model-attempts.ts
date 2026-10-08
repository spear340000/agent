import { AsyncLocalStorage } from 'node:async_hooks';
import { reportProgress } from '../../shared/task-progress.js';

export type ModelAttempt = { model: string; ok: boolean; ms: number; error?: string };

const store = new AsyncLocalStorage<ModelAttempt[]>();

/** Records, per task, which model answered or failed; concurrent tasks never share a list. */
export function runWithModelAttempts<T>(attempts: ModelAttempt[], work: () => Promise<T>): Promise<T> {
  return store.run(attempts, work);
}

export function recordModelAttempt(attempt: ModelAttempt): void {
  store.getStore()?.push(attempt);
  reportProgress(
    attempt.ok ? '모델 응답' : '모델 호출 실패 · 다음 모델로 전환',
    `${attempt.model} · ${(attempt.ms / 1000).toFixed(1)}초${attempt.error ? ` · ${attempt.error.slice(0, 120)}` : ''}`
  );
}

export function summarizeModelAttempts(attempts: readonly ModelAttempt[]): { finalModel: string | null; fellBack: boolean; failedModels: string[] } {
  const failedModels = [...new Set(attempts.filter(attempt => !attempt.ok).map(attempt => attempt.model))];
  const finalModel = [...attempts].reverse().find(attempt => attempt.ok)?.model ?? null;
  return { finalModel, fellBack: failedModels.length > 0, failedModels };
}
