import type { ModelProvider } from '../../domain/model-provider.js';
import { unavailable } from '../../shared/app-error.js';
import { ModelProviderError } from './model-provider-error.js';
import { recordModelAttempt, withUsageSlot, type ModelUsage } from './model-attempts.js';

export type NamedModelProvider = ModelProvider & { name: string; failureDomain?: string };

export type ModelFailoverOptions = {
  /** How long a provider account that reported exhausted credit or rejected credentials is skipped. */
  unhealthyCooldownMs?: number;
  /** Stop trying further providers once a request has spent this long, so sequential timeouts cannot pile up. */
  totalBudgetMs?: number;
  now?: () => number;
};

export class ModelFailoverProvider implements ModelProvider {
  private lastSuccessfulModelName: string | null = null;
  private readonly unhealthyUntil = new Map<string, number>();
  private readonly rateLimitedUntil = new Map<NamedModelProvider, number>();
  private readonly now: () => number;

  constructor(private readonly providers: readonly NamedModelProvider[], private readonly options: ModelFailoverOptions = {}) {
    if (providers.length === 0) throw new Error('at least one model provider must be configured');
    this.now = options.now ?? Date.now;
  }

  get lastSuccessfulModel(): string | null {
    return this.lastSuccessfulModelName;
  }

  /** Providers whose account is not in cooldown; when every account is in cooldown, all of them are tried again. */
  private candidates(): readonly NamedModelProvider[] {
    const now = this.now();
    const healthy = this.providers.filter(provider =>
      (!provider.failureDomain || (this.unhealthyUntil.get(provider.failureDomain) ?? 0) <= now) &&
      (this.rateLimitedUntil.get(provider) ?? 0) <= now
    );
    return healthy.length > 0 ? healthy : this.providers;
  }

  async complete(input: Parameters<ModelProvider['complete']>[0]): Promise<string> {
    const failures: string[] = [];
    const failedDomains = new Set<string>();
    const startedAtRequest = this.now();
    for (const provider of this.candidates()) {
      if (input.signal?.aborted) throw new Error('model request cancelled');
      if (provider.failureDomain && failedDomains.has(provider.failureDomain)) continue;
      if (this.options.totalBudgetMs !== undefined && failures.length > 0 && this.now() - startedAtRequest >= this.options.totalBudgetMs) {
        failures.push('전체 시도 시간 예산을 초과하여 나머지 모델은 시도하지 않았습니다.');
        break;
      }
      const startedAt = Date.now();
      try {
        const usage: ModelUsage = {};
        const result = await withUsageSlot(usage, () => provider.complete(input));
        this.lastSuccessfulModelName = provider.name;
        recordModelAttempt({ model: provider.name, ok: true, ms: Date.now() - startedAt, ...usage });
        return result;
      } catch (error) {
        recordModelAttempt({ model: provider.name, ok: false, ms: Date.now() - startedAt, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
        if (input.signal?.aborted || (error instanceof Error && error.message === 'model request cancelled')) throw new Error('model request cancelled');
        if (!(error instanceof ModelProviderError)) throw error;
        if (error.retryAfterMs) this.rateLimitedUntil.set(provider, this.now() + error.retryAfterMs);
        if (!error.fallbackEligible) {
          if (!error.crossProviderEligible || !provider.failureDomain) throw error;
          failedDomains.add(provider.failureDomain);
          if (this.options.unhealthyCooldownMs) this.unhealthyUntil.set(provider.failureDomain, this.now() + this.options.unhealthyCooldownMs);
        }
        failures.push(`${provider.name}: ${error.message}`);
      }
    }
    throw unavailable(`모든 모델 제공자 요청에 실패했습니다. ${failures.join(' / ')}`);
  }
}
