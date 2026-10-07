const WINDOW_MS = 60_000;

/** Rolling one-minute token budget for a provider tier that rejects requests over its tokens-per-minute limit. */
export class TokenRateLimiter {
  private events: Array<{ at: number; tokens: number }> = [];

  constructor(private readonly tokensPerMinute: number, private readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(tokensPerMinute) || tokensPerMinute < 1) throw new Error('tokensPerMinute must be a positive integer');
  }

  /** Milliseconds to wait before `tokens` fit in the window; 0 when they fit now, Infinity when they never can. */
  waitMs(tokens: number): number {
    if (tokens > this.tokensPerMinute) return Infinity;
    const now = this.now();
    this.events = this.events.filter(event => now - event.at < WINDOW_MS);
    let used = this.events.reduce((sum, event) => sum + event.tokens, 0);
    if (used + tokens <= this.tokensPerMinute) return 0;
    for (const event of this.events) {
      used -= event.tokens;
      if (used + tokens <= this.tokensPerMinute) return Math.max(0, event.at + WINDOW_MS - now);
    }
    return WINDOW_MS;
  }

  record(tokens: number): { tokens: number } {
    const event = { at: this.now(), tokens };
    this.events.push(event);
    return event;
  }

  /** Replaces a reservation with the provider's reported usage once the response is in. */
  settle(event: { tokens: number }, actualTokens: number): void {
    if (Number.isFinite(actualTokens) && actualTokens > 0) event.tokens = actualTokens;
  }
}

/** Korean text is about 1.6 characters per token; output is reserved because it counts against the same limit. */
export function estimateTokens(characters: number, reservedOutputTokens = 2_000): number {
  return Math.ceil(characters / 1.6) + reservedOutputTokens;
}
