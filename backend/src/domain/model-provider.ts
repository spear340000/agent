export interface ModelProvider {
  /** `expectedOutputTokens` lets small helper calls (a short JSON verdict) reserve far less rate budget than a full answer. */
  complete(input: { system: string; user: string; signal?: AbortSignal; expectedOutputTokens?: number }): Promise<string>;
}
