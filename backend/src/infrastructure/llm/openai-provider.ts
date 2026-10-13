import type { ModelProvider } from '../../domain/model-provider.js';
import { ModelProviderError } from './model-provider-error.js';
import { TokenRateLimiter, estimateTokens } from './token-rate-limiter.js';
import { noteModelUsage } from './model-attempts.js';

/** Longest a request waits for the token window to free up when this is the only provider. */
const MAX_RATE_LIMIT_WAIT_MS = 45_000;
/**
 * With another provider configured a long wait only delays the answer, and a wait as long as a caller's own timeout
 * (the claim verifier allows 45 s) ends the call as cancelled without ever reaching the next provider.
 */
const FAILOVER_RATE_LIMIT_WAIT_MS = 8_000;

export class OpenAiProvider implements ModelProvider {
  private readonly limiter?: TokenRateLimiter;

  constructor(private readonly options: { apiKey?: string; model: string; baseUrl: string; maxInputCharacters?: number; maxOutputBytes?: number; maxAttempts?: number; tokensPerMinute?: number; failFastOnRateLimit?: boolean; now?: () => number }) {
    if (options.tokensPerMinute !== undefined) this.limiter = new TokenRateLimiter(options.tokensPerMinute, options.now);
    if (options.maxInputCharacters !== undefined && (!Number.isSafeInteger(options.maxInputCharacters) || options.maxInputCharacters < 1)) throw new Error('maxInputCharacters must be a positive integer');
    if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1)) throw new Error('maxOutputBytes must be a positive integer');
    if (options.maxAttempts !== undefined && (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 3)) throw new Error('maxAttempts must be an integer from 1 to 3');
  }
  async complete(input: { system: string; user: string; signal?: AbortSignal; expectedOutputTokens?: number }): Promise<string> {
    const maxInputCharacters = this.options.maxInputCharacters ?? 200_000;
    if (input.system.length + input.user.length > maxInputCharacters) throw new ModelProviderError(`model input exceeds the configured limit of ${maxInputCharacters} characters`, true);
    if (!this.options.apiKey) throw new ModelProviderError('모델 제공자 API 키가 설정되지 않았습니다.');
    let reservation: { tokens: number; settled?: boolean } | undefined;
    if (this.limiter) {
      const tokens = estimateTokens(input.system.length + input.user.length, input.expectedOutputTokens);
      const wait = this.limiter.waitMs(tokens);
      if (wait > (this.options.failFastOnRateLimit ? FAILOVER_RATE_LIMIT_WAIT_MS : MAX_RATE_LIMIT_WAIT_MS)) {
        const reason = Number.isFinite(wait) ? `분당 토큰 한도에 도달했습니다(약 ${Math.ceil(wait / 1000)}초 뒤에 여유가 생겨 대기하지 않고 다음 모델로 전환합니다).` : '이 요청은 분당 토큰 한도보다 커서 이 모델로 보낼 수 없어 다음 모델로 전환합니다.';
        throw new ModelProviderError(reason, true, false, this.options.failFastOnRateLimit && Number.isFinite(wait) ? Math.min(wait, 60_000) : undefined);
      }
      if (wait > 0) await this.delay(0, input.signal, wait);
      reservation = this.limiter.record(tokens);
    }
    try {
      return await this.send(input, reservation);
    } catch (error) {
      // A request that failed before any usage was reported must not keep occupying the provider's token window.
      if (reservation) this.limiter?.release(reservation);
      throw error;
    }
  }
  private async send(input: { system: string; user: string; signal?: AbortSignal }, reservation?: { tokens: number; settled?: boolean }): Promise<string> {
    const endpoint = `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const maxAttempts = this.options.maxAttempts ?? 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response: Response;
      const requestStartedAt = Date.now();
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify({ model: this.options.model, messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }] }),
          signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (input.signal?.aborted) throw new Error('model request cancelled');
        if (attempt < maxAttempts - 1 && (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError'))) { await this.delay(attempt, input.signal); continue; }
        throw new ModelProviderError('model provider request failed or timed out. 모델 제공자 연결을 확인하세요.');
      }
      if (!response.ok) {
        let failure: { error?: { code?: unknown; type?: unknown } } = {};
        try {
          const parsed: unknown = JSON.parse(await this.readBounded(response, input.signal, 32_768));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) failure = parsed as typeof failure;
        }
        catch { /* Never forward arbitrary provider error bodies. */ }
        if (input.signal?.aborted) throw new Error('model request cancelled');
        if (failure.error?.type === 'insufficient_quota' || ['credit_balance_exhausted', 'insufficient_quota', 'billing_not_active'].includes(String(failure.error?.code))) {
          throw new ModelProviderError('모델 API 크레딧이 소진되었습니다. 설정된 모델 제공자 계정의 잔액·한도를 확인하세요.', false, true);
        }
        const rateLimited = response.status === 429;
        if (rateLimited && this.options.failFastOnRateLimit) {
          // Another provider is configured: skip this model for a while instead of retrying it on every call.
          const header = Number(response.headers.get('retry-after'));
          const cooldown = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 120_000) : 30_000;
          throw new ModelProviderError('model provider returned HTTP 429. 모델 제공자의 요청 한도에 도달해 잠시 이 모델을 건너뜁니다.', true, false, cooldown);
        }
        if (attempt < maxAttempts - 1 && [408, 429, 500, 502, 503, 504].includes(response.status)) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await this.delay(attempt, input.signal, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5_000) : undefined);
          continue;
        }
        const hint = response.status === 401 || response.status === 403 ? '모델 제공자의 API 키와 접근 권한을 확인하세요.' : response.status === 404 ? 'OPENAI_MODEL과 모델 접근 권한을 확인하세요.' : response.status === 429 ? '모델 제공자의 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.' : '모델 제공자의 응답 상태를 확인하세요.';
        const fallbackEligible = ![400, 401, 403, 413, 422].includes(response.status);
        // With another provider available, a model that keeps failing on the server side is skipped for a while rather
        // than tried first (and lost to a slow failure) on every later call of the same task.
        const serverSide = response.status >= 500 || response.status === 408;
        throw new ModelProviderError(`model provider returned HTTP ${response.status}. ${hint}`, fallbackEligible, [401, 403].includes(response.status), serverSide && this.options.failFastOnRateLimit ? 60_000 : undefined);
      }
      let payload: { choices?: Array<{ message?: { content?: string | null } }>; usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } };
      try {
        const body = await this.readBounded(response, input.signal);
        payload = JSON.parse(body) as typeof payload;
      }
      catch (error) {
        if (error instanceof Error && ['provider response exceeded configured size limit', 'model request cancelled'].includes(error.message)) throw error;
        throw new ModelProviderError('model provider returned invalid JSON');
      }
      if (reservation && this.limiter && typeof payload?.usage?.total_tokens === 'number') this.limiter.settle(reservation, payload.usage.total_tokens);
      if (typeof payload?.usage?.prompt_tokens === 'number' || typeof payload?.usage?.completion_tokens === 'number') {
        noteModelUsage({ promptTokens: payload.usage?.prompt_tokens, completionTokens: payload.usage?.completion_tokens, requestMs: Date.now() - requestStartedAt });
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new ModelProviderError('model provider returned an empty completion');
      return content;
    }
    throw new ModelProviderError('model provider retry limit exceeded');
  }
  private async readBounded(response: Response, signal?: AbortSignal, limit?: number): Promise<string> {
    const maxBytes = Math.min(limit ?? Number.MAX_SAFE_INTEGER, this.options.maxOutputBytes ?? 2 * 1024 * 1024);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel(); throw new Error('provider response exceeded configured size limit'); }
    if (!response.body) return '';
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        if (signal?.aborted) throw new Error('model request cancelled');
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('provider response exceeded configured size limit'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  }
  private delay(attempt: number, signal?: AbortSignal, override?: number): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('model request cancelled'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, override ?? 300 * (2 ** attempt));
      const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('model request cancelled')); };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
