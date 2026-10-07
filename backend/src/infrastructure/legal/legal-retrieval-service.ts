import {
  LEGAL_INDEXING_NOTICE,
  LegalRetrievalError,
  isLegalRetrievalError,
} from "../../domain/legal-error.js";
import type {
  LegalEvidence,
  LegalEvidenceFailure,
  LegalKnowledgeStatus,
  LegalRetrievalStep,
  LegalRetrievalTrace,
  LegalSource,
} from "../../domain/legal-source.js";
import type { McpStdioClient } from "./mcp-stdio-client.js";
import type { OfficialLawArticleReader } from "./official-law-article-reader.js";
import { extractLawArticle } from "../../domain/legal-reference.js";
import {
  graphIdentifiersFromRecords,
  readArticleCitations,
  readGraphRelations,
  searchGraphRelations,
} from "./legal-graph-reader.js";
import {
  graphRecord,
  isNotFoundToolError,
  isSearchEnvelope,
  lawRecordFromDocument,
  parseDocumentPayload,
  parseKnowledgeStatus,
  parseSearchResults,
  precedentRecordFromDocument,
  queryTerms,
  rankByCorpusEvidence,
  type NormalizedRecord,
} from "./legal-normalization.js";

export type LegalRetrievalLimits = {
  maxToolCalls: number;
  maxRetrievalSteps: number;
  maxQueryCharacters: number;
  maxPrecedentCharacters: number;
  graphPath?: string;
};

const CITATION_PREFIX: Record<LegalSource["corpus"], string> = {
  law: "L",
  precedent: "P",
  graph: "G",
  document: "D",
  web: "W",
};

const HARD_FAILURES = new Set([
  "startup",
  "transport",
  "timeout",
  "malformed",
  "protocol",
]);

const UNKNOWN_STATUS: LegalKnowledgeStatus = {
  server: null,
  laws: { ready: false },
  precedents: { ready: false },
  vector: { ready: false },
  graph: { ready: false },
  ontology: { ready: false },
  okf: { ready: false },
  degraded: ["status"],
  parsed: false,
};

type SearchEvidenceGroup = {
  byQuery: Map<string, NormalizedRecord[]>;
  records: Set<NormalizedRecord>;
};

export function sanitizeLegalQuery(
  query: string,
  maxCharacters: number,
): string {
  return query.replace(/\s+/g, " ").trim().slice(0, maxCharacters);
}

export function preserveLegalSearchQuery(
  query: string,
  maxCharacters: number,
): string {
  if (query.length > maxCharacters) {
    throw new LegalRetrievalError(
      "tool-error",
      `검색 질의는 ${maxCharacters}자 이하여야 합니다. 원문을 줄이지 않고 다시 요청해 주세요.`,
    );
  }
  return query;
}

function rankSearchEvidence(
  records: NormalizedRecord[],
  query: string,
): NormalizedRecord[] {
  const ranked = rankByCorpusEvidence(records, queryTerms(query)).filter(
    (record) => (record.relevance ?? 0) > 0,
  );
  const observedTerms = new Set(
    ranked.flatMap((record) => record.termMatches ?? []),
  );
  if (observedTerms.size < 2) return ranked;
  return ranked.filter((record) => {
    if ((record.termMatches?.length ?? 0) < 2) return false;
    if (record.corpus !== "precedent") return true;
    const identity = [record.title, record.caseName, record.caseNumber]
      .filter(Boolean)
      .join(" ");
    return (
      (record.termMatches ?? []).filter((term) => identity.includes(term))
        .length >= 2
    );
  });
}

export function assignCitationIds(records: NormalizedRecord[]): LegalSource[] {
  const counters = new Map<string, number>();
  const seen = new Set<string>();
  const sources: LegalSource[] = [];
  for (const record of records) {
    const key = `${record.corpus}:${record.recordId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const prefix = CITATION_PREFIX[record.corpus];
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    sources.push({ ...record, citationId: `${prefix}${next}` });
  }
  return sources;
}

export class LegalRetrievalService {
  private statusCache?: { value: LegalKnowledgeStatus; at: number };

  constructor(
    private readonly client: McpStdioClient,
    private readonly limits: LegalRetrievalLimits,
    private readonly officialArticles?: Pick<OfficialLawArticleReader, "read">,
  ) {}

  /** Precedents that cite one article, read directly from the local graph database (read-only, no MCP call). */
  articleCitations(lawName: string, articleNumber: string, limit = 20): LegalSource[] {
    if (!this.limits.graphPath) return [];
    try {
      return assignCitationIds(readArticleCitations(this.limits.graphPath, lawName, articleNumber, limit));
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    this.statusCache = undefined;
    await this.client.close();
  }

  async listTools(
    signal?: AbortSignal,
  ): Promise<Array<{ name: string; description: string }>> {
    return this.client.listTools(signal);
  }

  async knowledgeStatus(signal?: AbortSignal): Promise<LegalKnowledgeStatus> {
    const cached = this.statusCache;
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const { text } = await this.read("get_knowledge_status", {}, signal);
    const status = parseKnowledgeStatus(text);
    this.statusCache = { value: status, at: Date.now() };
    return status;
  }

  private async read(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string }> {
    const { text, isError } = await this.client.callTool(tool, args, signal);
    if (text.includes(LEGAL_INDEXING_NOTICE)) {
      throw new LegalRetrievalError(
        "indexing",
        "법령 지식 색인이 백그라운드에서 준비 중입니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    if (isError)
      throw new LegalRetrievalError(
        isNotFoundToolError(text) ? "not-found" : "tool-error",
        text.slice(0, 500),
      );
    return { text };
  }

  async searchLaws(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<NormalizedRecord[]> {
    return this.search(query, limit, "law", "search_laws", signal);
  }

  async searchPrecedents(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<NormalizedRecord[]> {
    return this.search(query, limit, "precedent", "search_precedents", signal);
  }

  async searchAll(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<NormalizedRecord[]> {
    return this.search(query, limit, "law", "search_all", signal);
  }

  async getLawArticle(
    lawName: string,
    articleNumber: string,
    signal?: AbortSignal,
  ): Promise<NormalizedRecord[]> {
    try {
      const { text } = await this.read(
        "get_law_article",
        { law_name: sanitizeLegalQuery(lawName, 80), article_number: sanitizeLegalQuery(articleNumber, 40) },
        signal,
      );
      const { header, body } = parseDocumentPayload(text);
      const record = lawRecordFromDocument(body || text, header);
      const compact = (value: string): string => value.replace(/\s+/g, "");
      if (compact(record.lawName ?? "") !== compact(lawName) || record.articleNumber !== compact(articleNumber)) {
        throw new LegalRetrievalError("not-found", "로컬 원문이 요청한 법령·조문과 일치하지 않습니다.");
      }
      return [record];
    } catch (error) {
      if (!isLegalRetrievalError(error) || error.kind !== "not-found" || !this.officialArticles || signal?.aborted) throw error;
      return this.officialArticles.read(lawName, articleNumber, signal);
    }
  }

  async getPrecedent(
    id: string,
    signal?: AbortSignal,
  ): Promise<NormalizedRecord[]> {
    const { record } = await this.getPrecedentDocument(id, 0, signal);
    return [record];
  }

  async getPrecedentDocument(
    id: string,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<{
    record: NormalizedRecord;
    paging: { offset?: number; total?: number; hasMore?: boolean };
    pageLength: number;
  }> {
    const { text } = await this.read(
      "get_precedent",
      {
        id: sanitizeLegalQuery(id, 160),
        offset,
        max_chars: this.limits.maxPrecedentCharacters,
      },
      signal,
    );
    const { header, paging, body, bodyLength } = parseDocumentPayload(text);
    return {
      record: precedentRecordFromDocument(body || text, header, { id }, paging),
      paging,
      pageLength: bodyLength,
    };
  }

  async findCaseNumber(
    caseNumber: string,
    signal?: AbortSignal,
  ): Promise<NormalizedRecord[]> {
    return this.search(caseNumber, 5, "precedent", "find_case_number", signal, {
      case_number: sanitizeLegalQuery(caseNumber, 40),
    });
  }

  async searchGraph(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<NormalizedRecord[]> {
    if (this.limits.graphPath) {
      const local = searchGraphRelations(this.limits.graphPath, query, limit);
      if (local.length) return local;
      const [laws, precedents] = await Promise.all([
        this.search(query, 10, "law", "search_laws", signal),
        this.search(query, 10, "precedent", "search_precedents", signal),
      ]);
      return searchGraphRelations(
        this.limits.graphPath,
        query,
        limit,
        graphIdentifiersFromRecords([...laws, ...precedents]),
      );
    }

    // The MCP counts seed nodes against `limit` and returns immediately when
    // seeds fill it, before traversing any edges. Request its bounded maximum,
    // then rank verified relation text and apply the caller's requested limit.
    const { text } = await this.read(
      "search_legal_graph",
      {
        query: preserveLegalSearchQuery(query, this.limits.maxQueryCharacters),
        limit: 10,
      },
      signal,
    );
    if (!isSearchEnvelope(text)) return [];
    const records = parseSearchResults(text, "graph");
    return rankSearchEvidence(records, query).slice(0, clampLimit(limit, 1, 10, 5));
  }

  async retrieve(
    steps: LegalRetrievalStep[],
    signal?: AbortSignal,
  ): Promise<LegalEvidence> {
    const failures: LegalEvidenceFailure[] = [];
    const status = await this.knowledgeStatus(signal).catch(
      (error: unknown) => {
        failures.push({
          step: "지식 계층 상태 확인",
          kind: isLegalRetrievalError(error) ? error.kind : "tool-error",
          message:
            error instanceof Error
              ? error.message.slice(0, 300)
              : String(error),
        });
        return UNKNOWN_STATUS;
      },
    );
    const bounded = steps.slice(0, this.limits.maxRetrievalSteps);
    const records: NormalizedRecord[] = [];
    const searchEvidence: SearchEvidenceGroup = {
      byQuery: new Map(),
      records: new Set(),
    };
    const executed: LegalRetrievalStep[] = [];
    const trace: LegalRetrievalTrace[] = [];
    let toolCalls = 0;
    for (const step of bounded) {
      if (toolCalls >= this.limits.maxToolCalls) {
        failures.push({
          step: describeStep(step),
          kind: "bounded",
          message: `도구 호출 한도(${this.limits.maxToolCalls})에 도달하여 나머지 검색을 생략했습니다.`,
        });
        break;
      }
      if (signal?.aborted)
        throw new LegalRetrievalError(
          "transport",
          "legal retrieval was cancelled",
        );
      toolCalls += 1;
      executed.push(step);
      try {
        const found = await this.runStep(step, signal, searchEvidence);
        records.push(...found);
        trace.push({ step, results: found.length });
      } catch (error) {
        trace.push({ step, results: 0 });
        if (
          isLegalRetrievalError(error) &&
          error.kind === "transport" &&
          /cancel/i.test(error.message)
        )
          throw error;
        if (!isLegalRetrievalError(error) || HARD_FAILURES.has(error.kind))
          throw error;
        failures.push({
          step: describeStep(step),
          kind: error.kind,
          message: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 300),
        });
      }
    }
    const crossCorpusSearchResults = [
      ...searchEvidence.byQuery.entries(),
    ].flatMap(([query, found]) => rankSearchEvidence(found, query));
    const sources = assignCitationIds([
      ...records.filter((record) => !searchEvidence.records.has(record)),
      ...crossCorpusSearchResults,
    ]);
    const degraded = [
      ...new Set([
        ...status.degraded,
        ...failures.map((failure) => failure.kind),
      ]),
    ].filter((kind) => kind !== "bounded");
    return {
      sources,
      status,
      degraded,
      failures,
      toolCalls,
      maxToolCalls: this.limits.maxToolCalls,
      steps: executed,
      trace,
    };
  }

  private async runStep(
    step: LegalRetrievalStep,
    signal: AbortSignal | undefined,
    searchEvidence: SearchEvidenceGroup,
  ): Promise<NormalizedRecord[]> {
    const limit = this.limits.maxQueryCharacters;
    if (
      (step.kind === "search-laws" ||
        step.kind === "search-precedents" ||
        step.kind === "search-all" ||
        step.kind === "graph") &&
      queryTerms(step.query).length === 0
    ) {
      throw new LegalRetrievalError(
        "not-found",
        "검색 가능한 한국어 또는 알파벳 항목을 찾지 못했습니다. 질문을 한국어로 다시 입력해 주세요.",
      );
    }
    switch (step.kind) {
      case "search-laws":
        return this.search(
          step.query,
          clampLimit(step.limit, 1, 20, 5),
          "law",
          "search_laws",
          signal,
          undefined,
          searchEvidence,
        );
      case "search-precedents":
        return this.search(
          step.query,
          clampLimit(step.limit, 1, 10, 5),
          "precedent",
          "search_precedents",
          signal,
          undefined,
          searchEvidence,
        );
      case "search-all":
        return this.search(
          step.query,
          clampLimit(step.limit, 1, 10, 5),
          "all",
          "search_all",
          signal,
          undefined,
          searchEvidence,
        );
      case "law-article":
        return this.getLawArticle(step.lawName, step.articleNumber, signal);
      case "precedent":
        return this.getPrecedent(step.id, signal);
      case "case-number":
        return this.findCaseNumber(step.caseNumber, signal);
      case "graph":
        return this.searchGraph(
          step.query,
          clampLimit(step.limit, 1, 10, 5),
          signal,
        );
    }
  }

  private async search(
    query: string,
    limit: number,
    corpus: "law" | "precedent" | "all",
    tool: string,
    signal?: AbortSignal,
    overrideArguments?: Record<string, unknown>,
    searchEvidence?: SearchEvidenceGroup,
  ): Promise<NormalizedRecord[]> {
    if (tool === "search_laws" && !overrideArguments) {
      const article = extractLawArticle(query);
      if (article?.lawName) return this.getLawArticle(article.lawName, article.articleNumber, signal);
    }
    const args: Record<string, unknown> = overrideArguments ?? {
      query: preserveLegalSearchQuery(query, this.limits.maxQueryCharacters),
      limit,
    };
    const { text } = await this.read(tool, args, signal);
    if (!isSearchEnvelope(text))
      return [graphRecord(sanitizeLegalQuery(query, 80), text.slice(0, 1_200))];
    const terms = queryTerms(query);
    const records =
      corpus === "all"
        ? parseSearchResults(text, "law")
        : parseSearchResults(text, corpus);
    if (searchEvidence && !overrideArguments) {
      const group = searchEvidence.byQuery.get(query) ?? [];
      group.push(...records);
      searchEvidence.byQuery.set(query, group);
      for (const record of records) searchEvidence.records.add(record);
      return records;
    }
    const ranked = rankByCorpusEvidence(records, terms);
    if (overrideArguments || terms.length === 0) return ranked;
    if (searchEvidence) return ranked;
    return rankSearchEvidence(records, query);
  }
}

function clampLimit(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isSafeInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function describeStep(step: LegalRetrievalStep): string {
  switch (step.kind) {
    case "search-laws":
      return `법령 검색: ${step.query}`;
    case "search-precedents":
      return `판례 검색: ${step.query}`;
    case "search-all":
      return `통합 검색: ${step.query}`;
    case "law-article":
      return `조문 조회: ${step.lawName} ${step.articleNumber}`;
    case "precedent":
      return `판례 원문: ${step.id}`;
    case "case-number":
      return `사건번호 조회: ${step.caseNumber}`;
    case "graph":
      return `관계 그래프 검색: ${step.query}`;
  }
}
