export type WebSearchResult = { title: string; url: string; snippet: string };

export interface WebSearchProvider {
  searchMany(queries: string[], limit?: number, signal?: AbortSignal): Promise<WebSearchResult[]>;
}
