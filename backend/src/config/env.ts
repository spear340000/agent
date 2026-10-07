import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveModelProviderConfig } from './model-providers.js';

function loadDotEnv(): void {
  try {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([^#=]+)\s*=\s*(.*?)\s*$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* .env is optional */ }
}

if (process.env.NODE_ENV !== 'test') loadDotEnv();

function positiveInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const LEGAL_HOME = path.resolve('backend/legal');
const LEGAL_RUNTIME_ROOT = path.resolve(
  process.env.LEGAL_RUNTIME_ROOT ?? process.env.LEGAL_RAG_ROOT ?? LEGAL_HOME,
);
const LEGAL_DATA_ROOT = path.resolve(
  process.env.LEGAL_DATA_ROOT ??
    (process.env.LEGAL_RAG_ROOT
      ? path.join(LEGAL_RUNTIME_ROOT, 'data')
      : path.join(LEGAL_HOME, 'data')),
);
const pythonPath = (environment: '.venv' | '.mcp-venv') =>
  process.platform === 'win32'
    ? path.join(LEGAL_RUNTIME_ROOT, environment, 'Scripts', 'python.exe')
    : path.join(LEGAL_RUNTIME_ROOT, environment, 'bin', 'python');
const LEGAL_PYTHON_FALLBACK = [
  pythonPath('.venv'),
  pythonPath('.mcp-venv'),
].find((candidate) => existsSync(candidate)) ?? pythonPath('.venv');

const MODEL_PROVIDER_CONFIG = resolveModelProviderConfig(process.env);

export const LEGAL_ROUTING_DEFAULTS = {
  multiIssueThreshold: 2,
  complexDraftCharacters: 700,
  multiAttachmentThreshold: 2
} as const;

export const LEGAL_RETRIEVAL_DEFAULTS = {
  directSourceLimit: 6,
  directQueryLimit: 2,
  orchestratedQueryLimit: 5,
  maxToolCalls: 12,
  maxRetrievalSteps: 8,
  maxPrecedentCharacters: 12_000
} as const;

export const env = {
  port: Number(process.env.PORT ?? 8787),
  apiAuthEnabled: process.env.API_AUTH_ENABLED === 'true',
  apiAuthToken: process.env.API_AUTH_TOKEN,
  databaseFile: process.env.DATABASE_FILE ?? 'data/agent.db',
  modelProviders: MODEL_PROVIDER_CONFIG,
  openAiApiKey: MODEL_PROVIDER_CONFIG.primary.apiKey,
  openAiModel: MODEL_PROVIDER_CONFIG.primary.model,
  openAiBaseUrl: MODEL_PROVIDER_CONFIG.primary.baseUrl,
  searxngUrl: process.env.SEARXNG_URL ?? 'http://127.0.0.1:8888',
  browserExecutablePath: process.env.BROWSER_EXECUTABLE_PATH,
  computerUseEnabled: process.env.COMPUTER_USE_ENABLED === 'true',
  maxRequestBytes: positiveInteger('MAX_REQUEST_BYTES', 16 * 1024 * 1024),
  maxUploadBytes: positiveInteger('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
  maxBrowserSessions: positiveInteger('MAX_BROWSER_SESSIONS', 4),
  frontendOrigins: (process.env.FRONTEND_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001').split(',').map(origin => origin.trim()).filter(Boolean),
  legal: {
    enabled: process.env.LEGAL_ENABLED !== 'false',
    root: LEGAL_DATA_ROOT,
    runtimeRoot: LEGAL_RUNTIME_ROOT,
    python: process.env.LEGAL_PYTHON ?? LEGAL_PYTHON_FALLBACK,
    script: process.env.LEGAL_MCP_SCRIPT ?? path.join(LEGAL_RUNTIME_ROOT, 'rag_mcp_server.py'),
    graphPath: process.env.LEGAL_GRAPH_PATH ?? path.join(LEGAL_DATA_ROOT, 'legal_graph.sqlite3'),
    ontologyPath: process.env.LEGAL_ONTOLOGY_PATH ?? path.join(LEGAL_RUNTIME_ROOT, 'ontology', 'legal-wiki.ttl'),
    okfPath: process.env.OKF_BUNDLE_PATH ?? path.join(LEGAL_RUNTIME_ROOT, 'okf', 'korea-legal'),
    qdrantPath: process.env.QDRANT_PATH ?? path.join(LEGAL_DATA_ROOT, 'qdrant'),
    vectorMemmapPath: process.env.VECTOR_MEMMAP_PATH ?? path.join(LEGAL_DATA_ROOT, 'vector_memmap'),
    useQdrant: process.env.USE_QDRANT === 'true' || process.env.LEGAL_VECTOR_SEARCH !== 'false',
    vectorBackend: process.env.QDRANT_BACKEND ?? 'memmap',
    embedModel: process.env.NVIDIA_EMBED_MODEL,
    embedDimension: process.env.NVIDIA_EMBED_DIM,
    startupTimeoutMs: positiveInteger('LEGAL_MCP_STARTUP_TIMEOUT_MS', 20_000),
    requestTimeoutMs: positiveInteger('LEGAL_MCP_REQUEST_TIMEOUT_MS', 45_000),
    maxResponseCharacters: positiveInteger('LEGAL_MCP_MAX_RESPONSE_CHARS', 2_000_000),
    maxQueryCharacters: positiveInteger('LEGAL_MAX_QUERY_CHARS', 300),
    routing: {
      multiIssueThreshold: positiveInteger('LEGAL_MULTI_ISSUE_THRESHOLD', LEGAL_ROUTING_DEFAULTS.multiIssueThreshold),
      complexDraftCharacters: positiveInteger('LEGAL_COMPLEX_DRAFT_CHARS', LEGAL_ROUTING_DEFAULTS.complexDraftCharacters),
      multiAttachmentThreshold: positiveInteger('LEGAL_MULTI_ATTACHMENT_THRESHOLD', LEGAL_ROUTING_DEFAULTS.multiAttachmentThreshold)
    },
    queryRewrite: process.env.LEGAL_QUERY_REWRITE !== 'false',
    wikiHints: process.env.LEGAL_WIKI_HINTS !== 'false',
    knowledgeChain: process.env.LEGAL_KNOWLEDGE_CHAIN !== 'false',
    evidenceBudgetChars: positiveInteger('LEGAL_EVIDENCE_BUDGET_CHARS', 6_000),
    claimVerification: process.env.LEGAL_CLAIM_VERIFICATION !== 'false',
    relevanceFilter: process.env.LEGAL_RELEVANCE_FILTER !== 'false',
    retrieval: {
      directSourceLimit: positiveInteger('LEGAL_DIRECT_SOURCE_LIMIT', LEGAL_RETRIEVAL_DEFAULTS.directSourceLimit),
      directQueryLimit: positiveInteger('LEGAL_DIRECT_QUERY_LIMIT', LEGAL_RETRIEVAL_DEFAULTS.directQueryLimit),
      orchestratedQueryLimit: positiveInteger('LEGAL_ORCHESTRATED_QUERY_LIMIT', LEGAL_RETRIEVAL_DEFAULTS.orchestratedQueryLimit),
      maxToolCalls: positiveInteger('LEGAL_MAX_TOOL_CALLS', LEGAL_RETRIEVAL_DEFAULTS.maxToolCalls),
      maxRetrievalSteps: positiveInteger('LEGAL_MAX_RETRIEVAL_STEPS', LEGAL_RETRIEVAL_DEFAULTS.maxRetrievalSteps),
      maxPrecedentCharacters: positiveInteger('LEGAL_MAX_PRECEDENT_CHARS', LEGAL_RETRIEVAL_DEFAULTS.maxPrecedentCharacters)
    },
    vectorProbeQuery: process.env.LEGAL_VECTOR_PROBE_QUERY ?? '칼날'
  }
} as const;

export function validateRuntimeConfig(config: { port: number; apiAuthEnabled?: boolean; apiAuthToken?: string; maxBrowserSessions?: number } = env): void {
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) throw new Error('PORT must be an integer from 1 to 65535');
  if (config.apiAuthEnabled && (!config.apiAuthToken || config.apiAuthToken.length < 32)) throw new Error('API_AUTH_TOKEN must be set and at least 32 characters when API_AUTH_ENABLED=true');
  if (config.maxBrowserSessions !== undefined && (!Number.isSafeInteger(config.maxBrowserSessions) || config.maxBrowserSessions < 1)) throw new Error('MAX_BROWSER_SESSIONS must be a positive integer');
}

export function validateLegalConfig(legal: typeof env.legal = env.legal): void {
  if (!legal.root) throw new Error('LEGAL_RAG_ROOT must be set');
  if (legal.enabled && (!legal.python || !legal.script)) throw new Error('LEGAL_PYTHON and LEGAL_MCP_SCRIPT must be set when legal retrieval is enabled');
  if (legal.routing.multiIssueThreshold < 1) throw new Error('LEGAL_MULTI_ISSUE_THRESHOLD must be at least 1');
  if (legal.retrieval.maxToolCalls < 1) throw new Error('LEGAL_MAX_TOOL_CALLS must be at least 1');
  if (legal.retrieval.maxRetrievalSteps < 1) throw new Error('LEGAL_MAX_RETRIEVAL_STEPS must be at least 1');
}
