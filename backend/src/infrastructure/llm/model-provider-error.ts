import { AppError } from '../../shared/app-error.js';

export class ModelProviderError extends AppError {
  /** `retryAfterMs`: how long this model should be skipped because the provider rate-limited it. */
  constructor(message: string, public readonly fallbackEligible = true, public readonly crossProviderEligible = false, public readonly retryAfterMs?: number) {
    super(503, message);
    this.name = 'ModelProviderError';
  }
}
