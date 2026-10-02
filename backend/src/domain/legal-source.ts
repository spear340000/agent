export type LegalCorpus = 'law' | 'precedent' | 'graph' | 'document' | 'web';
export type LegalSourceKind = 'law' | 'law-article' | 'precedent' | 'graph' | 'document' | 'web';
export type LegalDateKind = 'amendment' | 'decision';
export type LegalDate = { kind: LegalDateKind; value: string };
export type LegalRetrievalMode = 'direct' | 'orchestrated';
export type LegalGraphRelation = {
  sourceId: string;
  sourceLabel: string;
  sourceType: string;
  relation: string;
  targetId: string;
  targetLabel: string;
  targetType: string;
  sourcePath?: string;
  targetPath?: string;
};

export type LegalSource = {
  citationId: string;
  kind: LegalSourceKind;
  corpus: LegalCorpus;
  recordId: string;
  title: string;
  excerpt: string;
  lawName?: string;
  articleNumber?: string;
  articleLabel?: string;
  caseNumber?: string;
  precedentSerial?: string;
  caseName?: string;
  court?: string;
  courtLevel?: string;
  caseCategory?: string;
  officialUrl?: string;
  indexPath?: string;
  relatedArticles?: string[];
  date?: LegalDate;
  statusMarkers?: string[];
  termMatches?: string[];
  relevance?: number;
  truncated?: boolean;
  graphRelation?: LegalGraphRelation;
};

export type LegalLayerStatus = { ready: boolean; documents?: number; nodes?: number; edges?: number; reason?: string };

export type LegalKnowledgeStatus = {
  server: { name: string; version: string } | null;
  laws: LegalLayerStatus;
  precedents: LegalLayerStatus;
  vector: LegalLayerStatus;
  graph: LegalLayerStatus;
  ontology: LegalLayerStatus;
  okf: LegalLayerStatus;
  degraded: string[];
  parsed: boolean;
};

export type LegalRetrievalStep =
  | { kind: 'search-laws'; query: string; limit?: number }
  | { kind: 'search-precedents'; query: string; limit?: number }
  | { kind: 'search-all'; query: string; limit?: number }
  | { kind: 'law-article'; lawName: string; articleNumber: string }
  | { kind: 'precedent'; id: string; maxChars?: number }
  | { kind: 'case-number'; caseNumber: string }
  | { kind: 'graph'; query: string; limit?: number };

export type LegalEvidenceFailure = { step: string; kind: string; message: string };

export type LegalRetrievalTrace = { step: LegalRetrievalStep; results: number };

export type LegalEvidence = {
  sources: LegalSource[];
  status: LegalKnowledgeStatus;
  degraded: string[];
  failures: LegalEvidenceFailure[];
  toolCalls: number;
  maxToolCalls: number;
  steps: LegalRetrievalStep[];
  trace: LegalRetrievalTrace[];
};

export type LegalLayerUse = {
  id: 'law-keyword' | 'precedent-keyword' | 'vector' | 'graph' | 'ontology' | 'okf';
  label: string;
  state: 'used' | 'ready' | 'degraded' | 'unused' | 'unavailable';
  detail: string;
};

export type LegalToolUse = { tool: string; label: string; query: string; results: number };

export type LegalLedger = {
  layers: LegalLayerUse[];
  tools: LegalToolUse[];
  toolCalls: number;
  maxToolCalls: number;
  planner: { calls: number; mode: 'not-used' | 'used' };
};

export type LegalPlan = {
  title: string;
  issue: string;
  retrievalSteps: LegalRetrievalStep[];
  draft: boolean;
  needsWeb: boolean;
  webQueries: string[];
};

export type LegalCitation = {
  citationId: string;
  recordId: string;
  corpus: LegalCorpus;
  label: string;
  officialUrl?: string;
  date?: LegalDate;
};

export type LegalSourceStatus = {
  corpusReady: boolean;
  retrieved: number;
  cited: number;
  degraded: string[];
  currentness: 'unverified' | 'record-dated';
  notes: string[];
  failures: LegalEvidenceFailure[];
  ledger: LegalLedger;
};
