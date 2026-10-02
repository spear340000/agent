import type {
  LegalDate,
  LegalKnowledgeStatus,
  LegalLayerStatus,
  LegalSource
} from '../../domain/legal-source.js';

export type NormalizedRecord = Omit<LegalSource, 'citationId'>;

const READY = /ready=(True|False)/;
const DOCUMENTS = /documents=(\d+)/;
const NODES = /nodes=(\d+)/;
const EDGES = /edges=(\d+)/;
const REASON = /reason=(.*)$/;
const SERVER_HEADER = /^([A-Za-z0-9._-]+) (\d[\w.+-]*)$/;
const SEARCH_HEADER = /^Search:\s/;
const RESULT_COUNT = /^Results:\s*(\d+)$/;
const RECORD_BLOCK = /\n\[(\d+)\] /;
const LAW_NAME = /법률명:[ \t]*(.+?)(?=\r?\n|#{2,6}\s*제|\s{2,}\S|\s*$)/;
const ARTICLE_CAPTURE = /#{2,6}\s*제(\d+조(?:의\d+)?)(?:\s*\(([^)\n]{0,60})\))?/;
const AMENDMENT = /<((?:개정|신설|폐지|삭제|이동|명칭변경|전부개정)[^<>]{0,24})>/g;
const CASE_NUMBER = /(?:^|[^\d])(\d{4}[가-힣]{1,2}\d{2,})(?!\d)/;
const OFFICIAL_URL = /출처:\s*(https?:\/\/[^\s]+)/;
const RELATED_ARTICLES = /^##\s*참조조문\s*$/m;
const ARTICLE_ITEM = /제\s*\d+조/;

const PRECEDENT_FIELDS = [
  '판례일련번호',
  '사건번호',
  '사건명',
  '법원명',
  '법원등급',
  '사건종류',
  '출처',
  '선고일자'
] as const;

const NEXT_PRECEDENT_LABEL = '(?:판례일련번호|사건번호|사건명|법원명|법원등급|사건종류|출처|첨부파일|선고일자)';

type PrecedentMeta = {
  caseNumber?: string;
  precedentSerial?: string;
  caseName?: string;
  court?: string;
  courtLevel?: string;
  caseCategory?: string;
  officialUrl?: string;
  decidedAt?: string;
};

const sanitize = (value: string): string =>
  value.replace(/[^\p{L}\p{N}._:#-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'unknown';

const normalizeSpace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const unready = (): LegalLayerStatus => ({ ready: false });

export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .split(/[\s,.:;!?()[\]{}"'“”‘’·…]+/)
        .map(term => term.trim())
        .filter(term => term.length >= 2 && /[가-힣]/.test(term))
    )
  ];
}

const termMatches = (term: string, haystack: string): boolean => {
  if (haystack.includes(term)) return true;
  for (let size = term.length - 1; size >= 2; size -= 1) {
    if (haystack.includes(term.slice(0, size))) return true;
  }
  return false;
};

function haystackOf(record: NormalizedRecord): string {
  return `${record.title} ${record.lawName ?? ''} ${record.articleLabel ?? ''} ${record.caseNumber ?? ''} ${record.caseName ?? ''} ${record.excerpt}`;
}

export function rankByCorpusEvidence(records: NormalizedRecord[], terms: readonly string[]): NormalizedRecord[] {
  if (terms.length === 0 || records.length === 0) return records;
  const haystacks = records.map(haystackOf);
  const relevant = terms.filter(term => haystacks.some(haystack => termMatches(term, haystack)));
  if (relevant.length === 0) return records;
  const scored = records.map((record, index) => {
    const matched = relevant.filter(term => termMatches(term, haystacks[index]!));
    return { record, index, relevance: matched.length / relevant.length, matched };
  });
  const onTopic = scored.filter(entry => entry.relevance > 0);
  if (onTopic.length === 0) return records;
  const offTopic = scored.filter(entry => entry.relevance === 0);
  const keep = (entry: (typeof scored)[number]): NormalizedRecord => ({
    ...entry.record,
    relevance: entry.relevance,
    ...(entry.matched.length ? { termMatches: entry.matched } : { termMatches: [] })
  });
  return [
    ...onTopic.sort((left, right) => right.relevance - left.relevance || left.index - right.index).map(keep),
    ...offTopic.slice(0, 2).map(keep)
  ];
}

export function parseKnowledgeStatus(text: string): LegalKnowledgeStatus {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const status: LegalKnowledgeStatus = {
    server: null,
    laws: unready(),
    precedents: unready(),
    vector: unready(),
    graph: unready(),
    ontology: unready(),
    okf: unready(),
    degraded: [],
    parsed: false
  };
  const simpleLayers: LegalLayerStatus[] = [];
  let documentLayers = 0;
  for (const line of lines) {
    const header = SERVER_HEADER.exec(line);
    if (header && !READY.test(line)) {
      status.server = { name: header[1]!, version: header[2]! };
      continue;
    }
    if (!READY.test(line)) continue;
    const layer: LegalLayerStatus = { ready: /ready=True/.test(line) };
    const documents = DOCUMENTS.exec(line);
    const nodes = NODES.exec(line);
    const edges = EDGES.exec(line);
    const reason = REASON.exec(line);
    if (documents) layer.documents = Number(documents[1]);
    if (nodes) layer.nodes = Number(nodes[1]);
    if (edges) layer.edges = Number(edges[1]);
    if (reason) layer.reason = reason[1]!.trim();
    if (nodes || edges) status.graph = layer;
    else if (reason) status.vector = layer;
    else if (documents) {
      if (documentLayers === 0) status.laws = layer;
      else status.precedents = layer;
      documentLayers += 1;
    } else simpleLayers.push(layer);
  }
  status.ontology = simpleLayers[0] ?? unready();
  status.okf = simpleLayers[1] ?? unready();
  status.parsed = Boolean(status.server) || documentLayers > 0;
  if (!status.vector.ready) status.degraded.push('vector');
  if (!status.laws.ready || !status.precedents.ready) status.degraded.push('lexical');
  if (!status.graph.ready) status.degraded.push('graph');
  return status;
}

export function isSearchEnvelope(text: string): boolean {
  return text.split(/\r?\n/).some(line => SEARCH_HEADER.test(line.trim()) || RESULT_COUNT.test(line.trim()));
}

export function isNotFoundToolError(text: string): boolean {
  return /(?:not\s*found|찾지\s*못|없습니다|unknown tool|loading failed|not ready)/i.test(text);
}

export function parseSearchResults(text: string, corpus: 'law' | 'precedent' | 'graph'): NormalizedRecord[] {
  const parts = text.split(RECORD_BLOCK).slice(1);
  const records: NormalizedRecord[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const lines = (parts[index + 1] ?? '').split(/\r?\n/);
    const title = normalizeSpace(lines[0] ?? '');
    const location = normalizeSpace(lines[1] ?? '');
    const excerpt = normalizeSpace(lines.slice(2).join(' '));
    if (!title && !excerpt) continue;
    if (corpus === 'graph') records.push(parseGraphRecord(title || `graph-${index + 1}`, location));
    else if (corpus === 'law') records.push(normalizeLawRecord(title, location, excerpt));
    else records.push(normalizePrecedentRecord(title, location, excerpt));
  }
  return records;
}

function parseGraphRecord(id: string, serializedPath: string): NormalizedRecord {
  // The read-only MCP formats graph paths with Python's repr(list[dict]). Recover
  // only the explicit labels and relation names it actually returned; seed rows
  // have an empty path and therefore remain unpublishable as evidence.
  const fields = [...serializedPath.matchAll(/'(source_label|relation|target_label)':\s*'((?:\\.|[^'])*)'/gu)];
  const edges: Array<{ source: string; relation: string; target: string }> = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const source = fields[index];
    const relation = fields[index + 1];
    const target = fields[index + 2];
    if (source?.[1] !== 'source_label' || relation?.[1] !== 'relation' || target?.[1] !== 'target_label') continue;
    edges.push({ source: source[2]!, relation: relation[2]!, target: target[2]! });
  }
  const relationText = edges.map(edge => `${edge.source} —${edge.relation}→ ${edge.target}`).join(' / ');
  const record = graphRecord(id, relationText);
  if (edges.length) record.title = edges.at(-1)!.target;
  return record;
}

export function parseDocumentPayload(text: string): {
  header: string;
  paging: { offset?: number; total?: number; hasMore?: boolean };
  body: string;
  bodyLength: number;
} {
  const separator = text.indexOf('\n\n');
  const headerBlock = separator < 0 ? text : text.slice(0, separator);
  const body = separator < 0 ? '' : text.slice(separator + 2);
  const headerLines = headerBlock.split(/\r?\n/);
  const paging: { offset?: number; total?: number; hasMore?: boolean } = {};
  for (const line of headerLines.slice(1)) {
    const offset = /offset=(\d+)/.exec(line);
    const total = /total(?:_length)?=(\d+)/.exec(line);
    const hasMore = /has_more=(True|False)/.exec(line);
    if (offset) paging.offset = Number(offset[1]);
    if (total) paging.total = Number(total[1]);
    if (hasMore) paging.hasMore = hasMore[1] === 'True';
  }
  return {
    header: normalizeSpace(headerLines[0] ?? ''),
    paging,
    body: body.replace(/\s+$/, ''),
    bodyLength: [...body].length,
  };
}

export function normalizeLawRecord(
  title: string,
  location: string,
  excerpt: string,
  hints?: { lawName?: string; articleNumber?: string }
): NormalizedRecord {
  const article = ARTICLE_CAPTURE.exec(excerpt);
  const lawName = hints?.lawName ?? LAW_NAME.exec(excerpt)?.[1]?.trim() ?? title;
  const articleNumber = hints?.articleNumber ?? (article ? `제${article[1]}` : undefined);
  const record: NormalizedRecord = {
    kind: articleNumber ? 'law-article' : 'law',
    corpus: 'law',
    recordId: sanitize(`${lawName || 'law'}#${articleNumber ?? 'document'}`),
    title: lawName || '법령',
    excerpt
  };
  if (lawName) record.lawName = lawName;
  if (articleNumber) record.articleNumber = articleNumber;
  if (article) record.articleLabel = `제${article[1]}${article[2] ? ` (${article[2]})` : ''}`;
  if (location) record.indexPath = location;
  const markers = [...excerpt.matchAll(AMENDMENT)].map(match => match[1]!.trim());
  const amendment = markers.map(marker => /\d{4}\.\d{1,2}\.\d{1,2}/.exec(marker)?.[0]).find(Boolean);
  if (amendment) record.date = { kind: 'amendment', value: amendment };
  if (markers.length) record.statusMarkers = [...new Set(markers)];
  return record;
}

export function lawRecordFromDocument(
  body: string,
  header: string,
  hints?: { lawName?: string; articleNumber?: string }
): NormalizedRecord {
  const article = ARTICLE_CAPTURE.exec(body);
  const lawName = hints?.lawName ?? LAW_NAME.exec(body)?.[1]?.trim() ?? header;
  const articleNumber = hints?.articleNumber ?? (article ? `제${article[1]}` : undefined);
  return normalizeLawRecord(lawName, '', body, { lawName, articleNumber });
}

export function normalizePrecedentRecord(
  title: string,
  location: string,
  excerpt: string,
  hints?: { id?: string; caseNumber?: string }
): NormalizedRecord {
  const meta = extractPrecedentMetadata(excerpt);
  const caseNumber = hints?.caseNumber ?? meta.caseNumber;
  const record: NormalizedRecord = {
    kind: 'precedent',
    corpus: 'precedent',
    recordId: sanitize(
      caseNumber
        ? `case:${caseNumber}`
        : meta.precedentSerial
          ? `prec:${meta.precedentSerial}`
          : hints?.id ?? title ?? 'precedent'
    ),
    title: meta.caseName ?? title ?? '판례',
    excerpt
  };
  if (caseNumber) record.caseNumber = caseNumber;
  if (meta.precedentSerial) record.precedentSerial = meta.precedentSerial;
  if (meta.caseName) record.caseName = meta.caseName;
  if (meta.court) record.court = meta.court;
  if (meta.courtLevel) record.courtLevel = meta.courtLevel;
  if (meta.caseCategory) record.caseCategory = meta.caseCategory;
  if (meta.officialUrl) record.officialUrl = meta.officialUrl;
  if (meta.decidedAt) record.date = { kind: 'decision', value: meta.decidedAt };
  if (location) record.indexPath = location;
  const related = extractRelatedArticles(excerpt);
  if (related.length) record.relatedArticles = related;
  return record;
}

export function precedentRecordFromDocument(
  body: string,
  header: string,
  hints?: { id?: string; caseNumber?: string },
  paging: { total?: number; hasMore?: boolean } = {}
): NormalizedRecord {
  const record = normalizePrecedentRecord(header, '', body, hints);
  return paging.hasMore || (paging.total !== undefined && body.length < paging.total) ? { ...record, truncated: true } : record;
}

export function graphRecord(id: string, excerpt: string): NormalizedRecord {
  return {
    kind: 'graph',
    corpus: 'graph',
    recordId: sanitize(id || 'graph'),
    title: normalizeSpace(id) || '관계 그래프 근거',
    excerpt: normalizeSpace(excerpt)
  };
}

export function describeLawDate(date: LegalDate): string {
  return date.kind === 'amendment' ? `개정 표기 ${date.value}` : `선고 ${date.value}`;
}

function extractPrecedentMetadata(text: string): PrecedentMeta {
  const meta: PrecedentMeta = {};
  for (const field of PRECEDENT_FIELDS) {
    const line = new RegExp(`^${field}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(text);
    if (line) {
      assignPrecedentField(meta, field, line[1]!);
      continue;
    }
    const inline =
      field === '사건명'
        ? new RegExp(`${field}:[ \\t]*(.+?)(?=[ \\t]+${NEXT_PRECEDENT_LABEL}:|[ \\t]*---|\\s*$)`).exec(text)
        : new RegExp(`${field}:[ \\t]*(\\S+)`).exec(text);
    if (inline) assignPrecedentField(meta, field, inline[1]!);
  }
  if (!meta.caseNumber) {
    const found = CASE_NUMBER.exec(text);
    if (found) meta.caseNumber = found[1];
  }
  if (!meta.officialUrl) {
    const url = OFFICIAL_URL.exec(text)?.[1];
    if (url && url.length <= 2_048) meta.officialUrl = url;
  }
  return meta;
}

function assignPrecedentField(meta: PrecedentMeta, field: (typeof PRECEDENT_FIELDS)[number], value: string): void {
  if (field === '사건번호') meta.caseNumber = value;
  else if (field === '판례일련번호') meta.precedentSerial = value.replace(/^['"]|['"]$/g, '');
  else if (field === '사건명') meta.caseName = value;
  else if (field === '법원명') meta.court = value;
  else if (field === '법원등급') meta.courtLevel = value;
  else if (field === '사건종류') meta.caseCategory = value;
  else if (field === '선고일자') meta.decidedAt = value;
}

function extractRelatedArticles(text: string): string[] {
  const marker = RELATED_ARTICLES.exec(text);
  if (!marker || marker.index === undefined) return [];
  const rest = text.slice(marker.index + marker[0].length);
  const line = rest.split(/\r?\n/).map(normalizeSpace).find(value => value && !value.startsWith('#'));
  if (!line) return [];
  return [...new Set(line.split(/[,，]/).map(value => value.trim()).filter(value => ARTICLE_ITEM.test(value)))].slice(0, 12);
}
