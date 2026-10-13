export interface ModelProvider {
  /** `expectedOutputTokens` lets small helper calls (a short JSON verdict) reserve far less rate budget than a full answer. */
  /**
   * `maxRateLimitWaitMs` is how long the caller will wait for a full token window to free up: a call that can afford
   * it waits for the fast provider instead of falling through to a slower one.
   */
  complete(input: { system: string; user: string; signal?: AbortSignal; expectedOutputTokens?: number; maxRateLimitWaitMs?: number }): Promise<string>;
}
