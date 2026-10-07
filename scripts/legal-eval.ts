// Measures what each legal retrieval layer actually returns for a small gold set.
// Usage: npm run eval:legal   (spawns its own legal MCP process; does not touch the running backend)
import path from 'node:path';
import { env } from '../backend/src/config/env.js';
import { McpStdioClient } from '../backend/src/infrastructure/legal/mcp-stdio-client.js';
import { buildLegalMcpLaunchArgs } from '../backend/src/infrastructure/legal/mcp-launch.js';
import { LegalRetrievalService } from '../backend/src/infrastructure/legal/legal-retrieval-service.js';
import { OfficialLawArticleReader } from '../backend/src/infrastructure/legal/official-law-article-reader.js';
import { LegalWorkflow } from '../backend/src/application/legal/legal-workflow.js';
import { LegalRequestRouter } from '../backend/src/application/legal/legal-request-router.js';
import { ModelFailoverProvider } from '../backend/src/infrastructure/llm/model-failover-provider.js';
import { OpenAiProvider } from '../backend/src/infrastructure/llm/openai-provider.js';
import type { LegalRetrievalStep, LegalSource } from '../backend/src/domain/legal-source.js';

type Gold = { query: string; law: string; article: string };

// Each query has one article a competent answer must retrieve.
const GOLD: Gold[] = [
  { query: '불법행위로 인한 손해배상 책임', law: '민법', article: '750' },
  { query: '채무불이행 손해배상 청구', law: '민법', article: '390' },
  { query: '손해배상액의 예정', law: '민법', article: '398' },
  { query: '개인정보 유출 시 형사처벌', law: '개인정보 보호법', article: '71' },
  { query: '근로계약 해고 제한', law: '근로기준법', article: '23' },
  { query: '임대차 계약 갱신 요구', law: '주택임대차보호법', article: '6의3' },
  { query: '상속 순위', law: '민법', article: '1000' },
  { query: '정당방위 위법성 조각', law: '형법', article: '21' }
];

const layers: Array<{ id: string; step: (query: string) => LegalRetrievalStep }> = [
  { id: 'search-laws', step: query => ({ kind: 'search-laws', query, limit: 8 }) },
  { id: 'search-all', step: query => ({ kind: 'search-all', query, limit: 8 }) },
  { id: 'graph', step: query => ({ kind: 'graph', query, limit: 8 }) },
  { id: 'direct+rewrite', step: query => ({ kind: 'search-laws', query, limit: 8 }) }
];

function legalEnv(): Record<string, string> {
  const entries: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    USE_QDRANT: env.legal.useQdrant && process.env.EVAL_NO_VECTOR !== '1' ? 'true' : 'false',
    LEGAL_DATA_ROOT: env.legal.root,
    QDRANT_BACKEND: env.legal.vectorBackend,
    QDRANT_PATH: env.legal.qdrantPath,
    VECTOR_MEMMAP_PATH: env.legal.vectorMemmapPath,
    LEGAL_GRAPH_PATH: env.legal.graphPath,
    LEGAL_ONTOLOGY_PATH: env.legal.ontologyPath,
    OKF_BUNDLE_PATH: env.legal.okfPath,
    NVIDIA_API_KEY: env.openAiApiKey,
    NVIDIA_BASE_URL: env.openAiBaseUrl,
    NVIDIA_EMBED_MODEL: env.legal.embedModel,
    NVIDIA_EMBED_DIM: env.legal.embedDimension
  };
  return Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
}

const squash = (value: string): string => value.replace(/\s+/g, '');

/** Rank of the first result naming the expected law at all (spacing ignored), article not required. */
function lawHit(sources: LegalSource[], gold: Gold): number {
  return sources.findIndex(source => squash(`${source.lawName ?? ''}${source.title}`).includes(squash(gold.law)));
}

function hit(sources: LegalSource[], gold: Gold): number {
  const index = sources.findIndex(source => {
    const text = `${source.lawName ?? ''} ${source.articleNumber ?? ''} ${source.title}`;
    return text.includes(gold.law) && new RegExp(`제\\s*${gold.article.replace('의', '조의')}\\s*조?`).test(text);
  });
  return index; // -1 when absent, otherwise the rank (0-based)
}

const client = new McpStdioClient({
  command: env.legal.python,
  args: buildLegalMcpLaunchArgs(env.legal.script, path.resolve('data', 'legal-eval-mcp.log')),
  cwd: env.legal.runtimeRoot,
  env: legalEnv(),
  startupTimeoutMs: env.legal.startupTimeoutMs,
  requestTimeoutMs: env.legal.requestTimeoutMs,
  maxResponseCharacters: env.legal.maxResponseCharacters,
  restartBudget: 1,
  stderrTailCharacters: 4_000
});
const service = new LegalRetrievalService(client, {
  maxToolCalls: env.legal.retrieval.maxToolCalls,
  maxRetrievalSteps: env.legal.retrieval.maxRetrievalSteps,
  maxQueryCharacters: env.legal.maxQueryCharacters,
  maxPrecedentCharacters: env.legal.retrieval.maxPrecedentCharacters,
  graphPath: env.legal.graphPath
}, new OfficialLawArticleReader());

const endpoints = [env.modelProviders.primary, ...env.modelProviders.fallbacks];
const model = new ModelFailoverProvider(endpoints.map(endpoint => {
  const provider = new OpenAiProvider({ apiKey: endpoint.apiKey, model: endpoint.model, baseUrl: endpoint.baseUrl, maxAttempts: 2 });
  return { name: `${endpoint.name} · ${endpoint.model}`, failureDomain: endpoint.baseUrl, complete: (input: { system: string; user: string; signal?: AbortSignal }) => provider.complete(input) };
}));
const workflow = new LegalWorkflow({
  queryRewrite: true,
  retrieval: service,
  model,
  limits: { maxQueryCharacters: env.legal.maxQueryCharacters, orchestratedQueryLimit: 5, maxRetrievalSteps: env.legal.retrieval.maxRetrievalSteps, maxToolCalls: env.legal.retrieval.maxToolCalls, maxPrecedentCharacters: env.legal.retrieval.maxPrecedentCharacters, directSourceLimit: 6 }
});
const router = new LegalRequestRouter({ multiIssueThreshold: env.legal.routing.multiIssueThreshold, complexDraftCharacters: env.legal.routing.complexDraftCharacters, multiAttachmentThreshold: env.legal.routing.multiAttachmentThreshold, directQueryLimit: env.legal.retrieval.directQueryLimit, maxDirectQueryCharacters: env.legal.maxQueryCharacters });

const totals = new Map<string, { lawLevel: number; hits: number; top3: number; empty: number; failed: number; ms: number }>();
try {
  const status = await service.knowledgeStatus();
  console.log('layer status', JSON.stringify({ laws: status.laws, precedents: status.precedents, vector: status.vector, graph: status.graph, degraded: status.degraded }));
  for (const layer of layers) totals.set(layer.id, { lawLevel: 0, hits: 0, top3: 0, empty: 0, failed: 0, ms: 0 });
  for (const gold of GOLD) {
    const row: string[] = [];
    for (const layer of layers) {
      const total = totals.get(layer.id)!;
      const started = Date.now();
      try {
        const evidence = layer.id === 'direct+rewrite'
          ? await workflow.retrieve(router.route({ prompt: gold.query }), new AbortController().signal)
          : await service.retrieve([layer.step(gold.query)]);
        total.ms += Date.now() - started;
        const rank = hit(evidence.sources, gold);
        if (evidence.sources.length === 0) total.empty += 1;
        if (lawHit(evidence.sources, gold) >= 0) total.lawLevel += 1;
        if (rank >= 0) total.hits += 1;
        if (rank >= 0 && rank < 3) total.top3 += 1;
        if (evidence.failures.length) total.failed += 1;
        const queried = layer.id === 'direct+rewrite' ? ` q=[${evidence.steps.map(step => ('query' in step ? step.query : '')).join(' | ')}]` : '';
        const relations = layer.id === 'graph' ? ` rel=${[...new Set(evidence.sources.map(source => source.graphRelation?.relation))].join('/')}` : '';
        const misses = rank < 0 && layer.id !== 'graph' ? ` top=[${evidence.sources.slice(0, 3).map(source => source.title).join(' | ')}]` : '';
        row.push(`${layer.id}: n=${evidence.sources.length} rank=${rank}${relations}${queried}${misses}${evidence.failures.length ? ` FAIL(${evidence.failures[0]!.kind})` : ''}`);
      } catch (error) {
        total.ms += Date.now() - started;
        total.failed += 1;
        row.push(`${layer.id}: ERROR ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`);
      }
    }
    console.log(`${gold.law} 제${gold.article}조 ← "${gold.query}"\n  ${row.join('\n  ')}`);
  }
  console.log(`\nsummary over ${GOLD.length} gold queries (law = expected law named in results, article = expected article itself retrieved)`);
  for (const [id, total] of totals) {
    console.log(`${id.padEnd(12)} law ${total.lawLevel}/${GOLD.length}  article ${total.hits}/${GOLD.length}  top3 ${total.top3}/${GOLD.length}  empty ${total.empty}  failed ${total.failed}  avg ${Math.round(total.ms / GOLD.length)}ms`);
  }
} finally {
  await service.close();
  process.exit(0);
}
