import type { WebSearchProvider, WebSearchResult } from '../../domain/web-search.js';

const MAX_QUERIES = 3;
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 5;
const MAX_TITLE_LENGTH = 500;
const MAX_SNIPPET_LENGTH = 1_500;

export type SearxngSearchOptions = {
  baseUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('SearXNG response exceeded configured size limit');
  }

  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('SearXNG response exceeded configured size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

function normalizeResult(value: unknown): WebSearchResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Record<string, unknown>;
  if (typeof result.title !== 'string' || typeof result.url !== 'string') return undefined;

  const title = result.title.trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) return undefined;
  try {
    const url = new URL(result.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.hash = '';
    return {
      title,
      url: url.toString(),
      snippet: typeof result.content === 'string' ? result.content.trim().slice(0, MAX_SNIPPET_LENGTH) : '',
    };
  } catch {
    return undefined;
  }
}

export class SearxngSearchProvider implements WebSearchProvider {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: SearxngSearchOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Error('SEARXNG_URL must be an HTTP(S) URL without credentials, query, or fragment');
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
    this.endpoint = new URL('search', baseUrl);
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('SearXNG timeout must be a positive integer');
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error('SearXNG response limit must be a positive integer');
  }

  async searchMany(queries: string[], limit = 5, signal?: AbortSignal): Promise<WebSearchResult[]> {
    if (signal?.aborted) throw new Error('web search cancelled');
    const normalizedQueries = [...new Set(queries.map(query => query.trim().slice(0, MAX_QUERY_LENGTH)).filter(Boolean))].slice(0, MAX_QUERIES);
    if (!normalizedQueries.length) return [];
    const perQueryLimit = Math.max(1, Math.min(MAX_RESULTS, Number.isFinite(limit) ? Math.trunc(limit) : MAX_RESULTS));
    const batches = await Promise.all(normalizedQueries.map(query => this.searchOne(query, perQueryLimit, signal)));
    const seen = new Set<string>();
    const results: WebSearchResult[] = [];
    for (const result of batches.flat()) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      results.push(result);
      if (results.length >= MAX_QUERIES * perQueryLimit) break;
    }
    return results;
  }

  private async searchOne(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', 'auto');
    url.searchParams.set('safesearch', '1');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new Error('web search cancelled');
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': 'Workfolio/1.0' },
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        if (signal?.aborted) throw new Error('web search cancelled');
        if (controller.signal.aborted) throw new Error('SearXNG search timed out');
        throw new Error('SearXNG search request failed');
      }
      if (!response.ok) throw new Error(`SearXNG search returned HTTP ${response.status}`);
      const body = await readBoundedBody(response, this.maxResponseBytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error('SearXNG returned invalid JSON');
      }
      if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { results?: unknown }).results)) {
        throw new Error('SearXNG returned an invalid search response');
      }
      const seen = new Set<string>();
      const results: WebSearchResult[] = [];
      for (const item of (payload as { results: unknown[] }).results) {
        const result = normalizeResult(item);
        if (!result || seen.has(result.url)) continue;
        seen.add(result.url);
        results.push(result);
        if (results.length >= limit) break;
      }
      return results;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
