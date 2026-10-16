import { AsyncLocalStorage } from 'node:async_hooks';
import { reportProgress } from '../../shared/task-progress.js';

/** `requestMs`: time of the successful HTTP request itself, without waiting for the token window or earlier retries. */
export type ModelUsage = { promptTokens?: number; completionTokens?: number; requestMs?: number };
/** `startedAt`: epoch milliseconds when this attempt's request began, so a trace can place it on the timeline. */
export type ModelAttempt = { model: string; ok: boolean; ms: number; error?: string; startedAt?: number } & ModelUsage;

const usageStore = new AsyncLocalStorage<ModelUsage>();

/** The failover provider opens a slot around each provider call; the provider fills it with the usage the API reported. */
export function withUsageSlot<T>(slot: ModelUsage, work: () => Promise<T>): Promise<T> {
  return usageStore.run(slot, work);
}

export function noteModelUsage(usage: ModelUsage): void {
  const slot = usageStore.getStore();
  if (slot) Object.assign(slot, usage);
}

/** Tokens per second of generated output, or undefined when the call reported no output tokens or took no time. */
export function tokensPerSecond(completionTokens: number | undefined, ms: number): number | undefined {
  return completionTokens && completionTokens > 0 && ms > 0 ? completionTokens / (ms / 1000) : undefined;
}

type AttemptScope = { attempts: ModelAttempt[]; onAttempt?: (attempt: ModelAttempt) => void };
const store = new AsyncLocalStorage<AttemptScope>();

/**
 * Records, per task, which model answered or failed; concurrent tasks never share a list. `onAttempt` runs as each
 * call finishes, so a trace can show a call while the task is still running.
 */
export function runWithModelAttempts<T>(attempts: ModelAttempt[], work: () => Promise<T>, onAttempt?: (attempt: ModelAttempt) => void): Promise<T> {
  return store.run({ attempts, onAttempt }, work);
}

export function recordModelAttempt(attempt: ModelAttempt): void {
  const scope = store.getStore();
  scope?.attempts.push(attempt);
  scope?.onAttempt?.(attempt);
  const speed = tokensPerSecond(attempt.completionTokens, attempt.requestMs ?? attempt.ms);
  const waited = attempt.requestMs !== undefined && attempt.ms - attempt.requestMs >= 1_000 ? ` (대기 ${((attempt.ms - attempt.requestMs) / 1000).toFixed(1)}초 포함)` : '';
  const tokens = attempt.promptTokens !== undefined || attempt.completionTokens !== undefined
    ? ` · 입력 ${(attempt.promptTokens ?? 0).toLocaleString('ko-KR')} / 출력 ${(attempt.completionTokens ?? 0).toLocaleString('ko-KR')} 토큰${speed ? ` · ${speed.toFixed(0)} tok/s` : ''}`
    : '';
  reportProgress(
    attempt.ok ? '모델 응답' : '모델 호출 실패 · 다음 모델로 전환',
    `${attempt.model} · ${(attempt.ms / 1000).toFixed(1)}초${waited}${tokens}${attempt.error ? ` · ${attempt.error.slice(0, 120)}` : ''}`
  );
}

export type ModelTotals = { calls: number; failedCalls: number; promptTokens: number; completionTokens: number; totalMs: number; tokensPerSecond: number | null };

export function summarizeModelAttempts(attempts: readonly ModelAttempt[]): { finalModel: string | null; fellBack: boolean; failedModels: string[]; totals: ModelTotals } {
  const failedModels = [...new Set(attempts.filter(attempt => !attempt.ok).map(attempt => attempt.model))];
  const finalModel = [...attempts].reverse().find(attempt => attempt.ok)?.model ?? null;
  const generating = attempts.filter(attempt => attempt.ok && attempt.completionTokens && attempt.completionTokens > 0);
  const generatedTokens = generating.reduce((sum, attempt) => sum + (attempt.completionTokens ?? 0), 0);
  const generatingMs = generating.reduce((sum, attempt) => sum + (attempt.requestMs ?? attempt.ms), 0);
  return {
    finalModel,
    fellBack: failedModels.length > 0,
    failedModels,
    totals: {
      calls: attempts.length,
      failedCalls: attempts.filter(attempt => !attempt.ok).length,
      promptTokens: attempts.reduce((sum, attempt) => sum + (attempt.promptTokens ?? 0), 0),
      completionTokens: attempts.reduce((sum, attempt) => sum + (attempt.completionTokens ?? 0), 0),
      totalMs: attempts.reduce((sum, attempt) => sum + attempt.ms, 0),
      tokensPerSecond: generatingMs > 0 ? generatedTokens / (generatingMs / 1000) : null
    }
  };
}
