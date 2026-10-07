import { AppError } from '../../shared/app-error.js';

export class ModelProviderError extends AppError {
  constructor(message: string, public readonly fallbackEligible = true, public readonly crossProviderEligible = false) {
    super(503, message);
    this.name = 'ModelProviderError';
  }
}
