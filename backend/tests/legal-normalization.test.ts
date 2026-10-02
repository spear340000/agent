import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isNotFoundToolError,
  isSearchEnvelope,
  lawRecordFromDocument,
  parseDocumentPayload,
  parseSearchResults,
  precedentRecordFromDocument
} from '../src/infrastructure/legal/legal-normalization.ts';
import { assignCitationIds, LegalRetrievalService, preserveLegalSearchQuery, sanitizeLegalQuery } from '../src/infrastructure/legal/legal-retrieval-service.ts';

const LAW_SEARCH = [
  'Search: 채무자회생및파산에관한법률',
  'Results: 2',
  '',
  '[1] 채무자회생및파산에관한법률',
  'data\\legal\\full\\kr\\채무자회생및파산에관한법률\\법률.md',
  '법률명: 채무자회생및파산에관한법률 ##### 제566조 (면책의 효력) 면책을 받은 채무자는 파산절차에 의한 배당을 제외하고는 파산채권자에 대한 채무의 전부에 관하여 그 책임이 면제된다. <개정 2010.1.22> 1\\. 조세 2\\. 벌금',
  '',
  '[2] 위약금',
  '',
  '위약금'
].join('\n');

const PRECEDENT_SEARCH = [
  'Search: 대인관계에 관한 손해배상',
  'Results: 1',
  '',
  '[1] 인천지방법원_2015-07-03_2013가합30895',
  'data\\legal\\precedent\\민사\\하급심\\인천지방법원_2015-07-03_2013가합30895.md',
  "--- 판례일련번호: '179085' 사건번호: 2013가합30895 사건명: 손해배상(기) 법원명: 인천지방법원 법원등급: 하급심 사건종류: 민사 출처: https://www.law.go.kr/LSW/precInfoP.do?precSeq=179085 첨부파일: [] 선고일자: 2015-07-03 --- # 손해배상(기) ## 판시사항 집단괴롭힘"
].join('\n');

const ARTICLE_DOCUMENT = [
  '민법',
  '',
  '법률명: 민법',
  '##### 제398조 (배상액의 예정)',
  '',
  '**①** 당사자는 채무불이행에 관한 손해배상액을 예정할 수 있다.',
  '',
  '**②** 손해배상의 예정액이 부당히 과다한 경우에는 법원은 적당히 감액할 수 있다.'
].join('\n');

const PRECEDENT_DOCUMENT = [
  '인천지방법원_2015-07-03_2013가합30895',
  'offset=0 total=12766 has_more=True',
  '',
  '---',
  "판례일련번호: '179085'",
  '사건번호: 2013가합30895',
  '사건명: 손해배상(기)',
  '법원명: 인천지방법원',
  '법원등급: 하급심',
  '사건종류: 민사',
  '출처: https://www.law.go.kr/LSW/precInfoP.do?precSeq=179085',
  '선고일자: 2015-07-03',
  '---',
  '',
  '# 손해배상(기)',
  '',
  '## 참조조문',
  '',
  '민법 제750조, 제753조, 제760조',
  '',
  '## 판결요지',
  '',
  '집단괴롭힘'
].join('\n');

test('search envelopes are distinguished from document payloads', () => {
  assert.equal(isSearchEnvelope(LAW_SEARCH), true);
  assert.equal(isSearchEnvelope(ARTICLE_DOCUMENT), false);
  assert.equal(isSearchEnvelope(PRECEDENT_DOCUMENT), false);
});

test('law search records keep law, article, amendment, and index identifiers', () => {
  const records = parseSearchResults(LAW_SEARCH, 'law');
  assert.equal(records.length, 2);
  const first = records[0]!;
  assert.equal(first.kind, 'law-article');
  assert.equal(first.corpus, 'law');
  assert.equal(first.lawName, '채무자회생및파산에관한법률');
  assert.equal(first.articleNumber, '제566조');
  assert.equal(first.articleLabel, '제566조 (면책의 효력)');
  assert.deepEqual(first.date, { kind: 'amendment', value: '2010.1.22' });
  assert.deepEqual(first.statusMarkers, ['개정 2010.1.22']);
  assert.equal(first.indexPath, 'data\\legal\\full\\kr\\채무자회생및파산에관한법률\\법률.md');
  assert.equal(records[1]!.kind, 'law');
  assert.equal(records[1]!.articleNumber, undefined);
});

test('precedent search records keep case identity, court, official link, and date', () => {
  const [record] = parseSearchResults(PRECEDENT_SEARCH, 'precedent');
  assert.ok(record);
  assert.equal(record.caseNumber, '2013가합30895');
  assert.equal(record.precedentSerial, '179085');
  assert.equal(record.caseName, '손해배상(기)');
  assert.equal(record.court, '인천지방법원');
  assert.equal(record.courtLevel, '하급심');
  assert.equal(record.caseCategory, '민사');
  assert.equal(record.officialUrl, 'https://www.law.go.kr/LSW/precInfoP.do?precSeq=179085');
  assert.deepEqual(record.date, { kind: 'decision', value: '2015-07-03' });
});

test('graph search results recover explicit relationship labels from the MCP path representation', () => {
  const text = [
    'Search: 불법행위 손해배상',
    'Results: 2',
    '',
    '[1] concept:불법행위',
    '[]',
    '',
    '[2] concept:불법행위-related',
    "[{'source_id': 'case:123', 'source_label': '손해배상 사건', 'relation': 'RELATES_TO', 'target_id': 'concept:불법행위', 'target_label': '불법행위', 'target_type': 'LegalConcept'}]",
    ''
  ].join('\n');
  const [seed, edge] = parseSearchResults(text, 'graph');
  assert.equal(seed?.title, 'concept:불법행위');
  assert.equal(edge?.title, '불법행위');
  assert.match(edge?.excerpt ?? '', /손해배상 사건 —RELATES_TO→ 불법행위/);
});

test('an exact article document keeps the statutory text separate from the record identity', () => {
  const parsed = parseDocumentPayload(ARTICLE_DOCUMENT);
  assert.equal(parsed.header, '민법');
  assert.equal(parsed.paging.offset, undefined);
  const record = lawRecordFromDocument(parsed.body, parsed.header, { lawName: '민법', articleNumber: '제398조' });
  assert.equal(record.lawName, '민법');
  assert.equal(record.articleNumber, '제398조');
  assert.equal(record.articleLabel, '제398조 (배상액의 예정)');
  assert.match(record.excerpt, /손해배상의 예정액이 부당히 과다한 경우/);
});

test('article identity is recovered from the document body when the caller has no hints', () => {
  const parsed = parseDocumentPayload(ARTICLE_DOCUMENT);
  const record = lawRecordFromDocument(parsed.body, parsed.header);
  assert.equal(record.lawName, '민법');
  assert.equal(record.articleNumber, '제398조');
});

test('a paged precedent document reports truncation and reference articles', () => {
  const parsed = parseDocumentPayload(PRECEDENT_DOCUMENT);
  assert.equal(parsed.header, '인천지방법원_2015-07-03_2013가합30895');
  assert.deepEqual(parsed.paging, { offset: 0, total: 12766, hasMore: true });
  const record = precedentRecordFromDocument(parsed.body, parsed.header, { id: '2013가합30895' }, parsed.paging);
  assert.equal(record.truncated, true);
  assert.equal(record.caseNumber, '2013가합30895');
  assert.deepEqual(record.relatedArticles, ['민법 제750조', '제753조', '제760조']);
});

test('precedent paging parses the MCP total_length field', () => {
  const parsed = parseDocumentPayload('판례\noffset=12000 total_length=23000 has_more=True\n\n본문');
  assert.deepEqual(parsed.paging, { offset: 12000, total: 23000, hasMore: true });
});

test('citation handles are assigned per corpus and duplicates collapse', () => {
  const sources = assignCitationIds([
    { kind: 'law', corpus: 'law', recordId: 'law:A', title: 'A', excerpt: '' },
    { kind: 'law', corpus: 'law', recordId: 'law:A', title: 'A', excerpt: '' },
    { kind: 'precedent', corpus: 'precedent', recordId: 'case:B', title: 'B', excerpt: '' },
    { kind: 'graph', corpus: 'graph', recordId: 'concept:C', title: 'C', excerpt: '' },
    { kind: 'document', corpus: 'document', recordId: 'TXT1:a.txt', title: 'a.txt', excerpt: '' },
    { kind: 'web', corpus: 'web', recordId: 'https://example.com', title: 'page', excerpt: '' }
  ]);
  assert.deepEqual(sources.map(source => source.citationId), ['L1', 'P1', 'G1', 'D1', 'W1']);
});

test('non-query identifiers can be normalized and bounded safely', () => {
  assert.equal(sanitizeLegalQuery('  위약금\n  감액 ', 50), '위약금 감액');
  assert.equal(sanitizeLegalQuery('abcdefghij', 4), 'abcd');
});

test('a search query is passed to the legal index byte-for-byte without whitespace edits', async () => {
  const query = '  위약금\n\t감액  ';
  let actualQuery = '';
  const client = {
    callTool: async (_name: string, args: Record<string, unknown>) => {
      actualQuery = String(args.query);
      return {
        text: ['Search: 위약금', 'Results: 1', '', '[1] 위약금 감액', '', '위약금 감액은 법원에서 판단한다'].join('\n'),
        isError: false
      };
    }
  } as never;
  const retrieval = new LegalRetrievalService(client, {
    maxToolCalls: 2,
    maxRetrievalSteps: 2,
    maxQueryCharacters: 100,
    maxPrecedentCharacters: 1_000
  });
  const found = await retrieval.searchLaws(query, 5);
  assert.equal(actualQuery, query);
  assert.equal(found.length, 1);
  assert.equal(preserveLegalSearchQuery(query, 100), query);
  assert.throws(() => preserveLegalSearchQuery(`${query} ${'가'.repeat(100)}`, 100), /원문을 줄이지 않고/);
});

test('unmatched search results are not promoted into the legal evidence list', async () => {
  const client = {
    callTool: async () => ({
      text: ['Search: 칼날', 'Results: 2', '', '[1] 장애인복지법', '', '장애 등록과 지원에 관한 규정', '', '[2] 질서위반행위규제법', '', '과태료 절차'].join('\n'),
      isError: false
    })
  } as never;
  const retrieval = new LegalRetrievalService(client, {
    maxToolCalls: 2,
    maxRetrievalSteps: 2,
    maxQueryCharacters: 100,
    maxPrecedentCharacters: 1_000
  });
  assert.deepEqual(await retrieval.searchLaws('칼날', 5), []);
});

test('same-query law and precedent searches reject incidental body matches without mutating the query', async () => {
  const client = {
    callTool: async (name: string) => {
      if (name === 'get_knowledge_status') {
        return { text: 'korea-legal-rag 0.2.1\n키워드/법령: ready=True documents=10\n키워드/판례: ready=True documents=10', isError: false };
      }
      if (name === 'search_laws') {
        return { text: ['Search: 대인관계 손해배상', 'Results: 1', '', '[1] 손해배상', '', '손해배상 관련 규정'].join('\n'), isError: false };
      }
      return { text: ['Search: 대인관계 손해배상', 'Results: 2', '', '[1] 대인관계 손해배상 청구사건', '', '대인관계에서 발생한 손해배상', '', '[2] 손해배상 청구사건', '', '판결요지에 대인관계 단어가 한 차례 등장하지만 사건명은 손해배상 청구사건이다'].join('\n'), isError: false };
    }
  } as never;
  const retrieval = new LegalRetrievalService(client, {
    maxToolCalls: 4,
    maxRetrievalSteps: 4,
    maxQueryCharacters: 100,
    maxPrecedentCharacters: 1_000
  });
  const evidence = await retrieval.retrieve([
    { kind: 'search-laws', query: '대인관계 손해배상', limit: 5 },
    { kind: 'search-precedents', query: '대인관계 손해배상', limit: 5 }
  ]);
  assert.equal(evidence.sources.length, 1);
  assert.equal(evidence.sources[0]?.corpus, 'precedent');
  assert.equal(evidence.sources[0]?.title, '대인관계 손해배상 청구사건');
  assert.equal(evidence.sources[0]?.relevance, 1);
  assert.deepEqual(evidence.sources[0]?.termMatches, ['대인관계', '손해배상']);
});

test('tool errors that mean "no record" are separated from real failures', () => {
  assert.equal(isNotFoundToolError('Error: law article not found: 민법 제9999조'), true);
  assert.equal(isNotFoundToolError('Error: precedent not found: abc'), true);
  assert.equal(isNotFoundToolError('Error: sqlite3.OperationalError: database is locked'), false);
});
