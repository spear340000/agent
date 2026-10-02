import type { ModelProvider } from '../../domain/model-provider.js';
import { unavailable } from '../../shared/app-error.js';

export class OpenAiProvider implements ModelProvider {
  constructor(private readonly options: { apiKey?: string; model: string; baseUrl: string; maxInputCharacters?: number; maxOutputBytes?: number }) {
    if (options.maxInputCharacters !== undefined && (!Number.isSafeInteger(options.maxInputCharacters) || options.maxInputCharacters < 1)) throw new Error('maxInputCharacters must be a positive integer');
    if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1)) throw new Error('maxOutputBytes must be a positive integer');
  }
  async complete(input: { system: string; user: string; signal?: AbortSignal }): Promise<string> {
    const maxInputCharacters = this.options.maxInputCharacters ?? 200_000;
    if (input.system.length + input.user.length > maxInputCharacters) throw new Error(`model input exceeds the configured limit of ${maxInputCharacters} characters`);
    if (!this.options.apiKey) throw unavailable('모델 제공자 API 키가 설정되지 않았습니다. OPENAI_API_KEY를 확인하세요.');
    const endpoint = `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify({ model: this.options.model, messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }] }),
          signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (input.signal?.aborted) throw new Error('model request cancelled');
        if (attempt < 2 && (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError'))) { await this.delay(attempt, input.signal); continue; }
        throw unavailable('model provider request failed or timed out. 모델 제공자 연결을 확인하세요.');
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
          throw unavailable('모델 API 크레딧이 소진되었습니다. 설정된 모델 제공자 계정의 잔액·한도를 확인하세요.');
        }
        if (attempt < 2 && [408, 429, 500, 502, 503, 504].includes(response.status)) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await this.delay(attempt, input.signal, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5_000) : undefined);
          continue;
        }
        const hint = response.status === 401 || response.status === 403 ? '모델 제공자의 API 키와 접근 권한을 확인하세요.' : response.status === 404 ? 'OPENAI_MODEL과 모델 접근 권한을 확인하세요.' : response.status === 429 ? '모델 제공자의 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.' : '모델 제공자의 응답 상태를 확인하세요.';
        throw unavailable(`model provider returned HTTP ${response.status}. ${hint}`);
      }
      let payload: { choices?: Array<{ message?: { content?: string | null } }> };
      try {
        const body = await this.readBounded(response, input.signal);
        payload = JSON.parse(body) as typeof payload;
      }
      catch (error) {
        if (error instanceof Error && ['provider response exceeded configured size limit', 'model request cancelled'].includes(error.message)) throw error;
        throw new Error('model provider returned invalid JSON');
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('model provider returned an empty completion');
      return content;
    }
    throw new Error('model provider retry limit exceeded');
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
