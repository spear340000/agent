export interface ModelProvider {
  complete(input: { system: string; user: string; signal?: AbortSignal }): Promise<string>;
}
