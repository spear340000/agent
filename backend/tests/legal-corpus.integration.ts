import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { env } from '../src/config/env.ts';
import { McpStdioClient } from '../src/infrastructure/legal/mcp-stdio-client.ts';
import { buildLegalMcpLaunchArgs } from '../src/infrastructure/legal/mcp-launch.ts';
import { LegalRetrievalService } from '../src/infrastructure/legal/legal-retrieval-service.ts';
import { parseKnowledgeStatus } from '../src/infrastructure/legal/legal-normalization.ts';

const corpusRoot = process.env.LEGAL_CORPUS_ROOT ?? env.legal.root;
const corpusReady = existsSync(`${corpusRoot}/legal_fts.sqlite3`) && existsSync(`${corpusRoot}/precedent_fts.sqlite3`);
const legalRuntimeReady = existsSync(process.env.LEGAL_PYTHON ?? env.legal.python)
  && existsSync(process.env.LEGAL_MCP_SCRIPT ?? env.legal.script);
const legalIntegrationSkipReason = !corpusReady
  ? `corpus not available at ${corpusRoot}`
  : !legalRuntimeReady
    ? "legal Python runtime is not installed; run npm run setup:legal"
    : false;

test('read-only knowledge status parsing classifies every layer', () => {
  const status = parseKnowledgeStatus(
    [
      'korea-legal-rag 0.2.1',
      '키워드/법령: ready=True documents=81445',
      '키워드/판례: ready=True documents=124925',
      '벡터: ready=False reason=disabled by USE_QDRANT=false (safe default)',
      '그래프: ready=True nodes=429245 edges=772682',
      '온톨로지: ready=True',
      'OKF: ready=False'
    ].join('\n')
  );
  assert.equal(status.parsed, true);
  assert.deepEqual(status.server, { name: 'korea-legal-rag', version: '0.2.1' });
  assert.deepEqual(status.laws, { ready: true, documents: 81445 });
  assert.deepEqual(status.precedents, { ready: true, documents: 124925 });
  assert.equal(status.vector.ready, false);
  assert.match(String(status.vector.reason), /USE_QDRANT=false/);
  assert.deepEqual(status.graph, { ready: true, nodes: 429245, edges: 772682 });
  assert.deepEqual(status.ontology, { ready: true });
  assert.deepEqual(status.okf, { ready: false });
  assert.deepEqual(status.degraded, ['vector']);
});

test('the supplied corpus answers law, precedent, and graph lookups read-only', { skip: legalIntegrationSkipReason }, async () => {
  const client = new McpStdioClient({
    command: process.env.LEGAL_PYTHON ?? env.legal.python,
    args: buildLegalMcpLaunchArgs(process.env.LEGAL_MCP_SCRIPT ?? env.legal.script, `${process.cwd()}/data/legal-rag-mcp-test.log`),
    cwd: env.legal.runtimeRoot,
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    startupTimeoutMs: env.legal.startupTimeoutMs,
    requestTimeoutMs: env.legal.requestTimeoutMs,
    maxResponseCharacters: env.legal.maxResponseCharacters,
    restartBudget: 1,
    stderrTailCharacters: 4_000
  });
  const retrieval = new LegalRetrievalService(client, {
    maxToolCalls: 8,
    maxRetrievalSteps: 6,
    maxQueryCharacters: env.legal.maxQueryCharacters,
    maxPrecedentCharacters: 6_000,
    graphPath: env.legal.graphPath
  });
  try {
    const status = await retrieval.knowledgeStatus();
    assert.equal(status.parsed, true);
    assert.equal(status.laws.ready, true);
    assert.equal(status.precedents.ready, true);
    assert.ok((status.laws.documents ?? 0) > 0);
    assert.equal(status.vector.ready, false, 'the supplied bundle keeps vector retrieval disabled');

    const evidence = await retrieval.retrieve([
      { kind: 'law-article', lawName: '민법', articleNumber: '제398조' },
      { kind: 'search-precedents', query: '손해배상청구사건', limit: 2 }
    ]);
    assert.deepEqual(evidence.failures, []);
    assert.ok(evidence.toolCalls >= 2);
    const article = evidence.sources.find(source => source.citationId === 'L1');
    assert.ok(article, 'the first law record receives the L1 citation handle');
    assert.equal(article.corpus, 'law');
    assert.equal(article.lawName, '민법');
    assert.equal(article.articleNumber, '제398조');
    assert.match(article.excerpt, /배상액의 예정/);
    assert.match(article.recordId, /민법/);
    const precedent = evidence.sources.find(source => source.citationId === 'P1');
    assert.ok(precedent, 'the first precedent record receives the P1 citation handle');
    assert.equal(precedent.corpus, 'precedent');
    assert.ok(precedent.caseNumber || precedent.precedentSerial || precedent.indexPath);
    assert.ok(precedent.excerpt.length > 0);
    assert.ok(evidence.sources.every(source => /^[LPG]\d+$/.test(source.citationId)));

    const incidentalMatch = await retrieval.retrieve([
      { kind: 'search-laws', query: '대인관계 손해배상', limit: 5 },
      { kind: 'search-precedents', query: '대인관계 손해배상', limit: 5 }
    ]);
    assert.ok(incidentalMatch.trace.some(entry => entry.results > 0), 'the corpus must return raw candidate records for the query');
    assert.equal(incidentalMatch.sources.length, 0, 'body-only incidental terms must not be published as supporting evidence');

    const exact = await retrieval.getPrecedent('2013가합30895');
    assert.equal(exact.length, 1);
    assert.equal(exact[0]!.caseNumber, '2013가합30895');
    assert.equal(exact[0]!.court, '인천지방법원');
    assert.match(String(exact[0]!.officialUrl), /^https:\/\/www\.law\.go\.kr\//);
    assert.equal(exact[0]!.date?.kind, 'decision');

    const byCaseNumber = await retrieval.findCaseNumber('2013가합30895');
    assert.equal(byCaseNumber.length, 1);

    const graph = await retrieval.searchGraph('불법행위 손해배상', 5);
    assert.ok(graph.some(record => record.corpus === 'graph' && /불법행위|손해배상/u.test(`${record.title} ${record.excerpt}`)), 'graph search should resolve raw-query index hits to actual read-only relationship edges');
    assert.ok(graph.some(record => record.graphRelation?.relation === 'RELATES_TO'), 'semantic concept edges should rank ahead of provenance-only links');
    assert.ok(graph.every(record => record.graphRelation), 'the graph UI receives typed source/target nodes, edge type, and provenance');

    const exactArticleGraph = await retrieval.searchGraph('민법 제750조', 10);
    assert.ok(exactArticleGraph.some(record => record.graphRelation?.relation === 'CITES_ARTICLE' && record.graphRelation.targetId.endsWith(':article:750')), 'law/article records from the unchanged lexical query resolve to the matching graph article');

    const peopleGraph = await retrieval.searchGraph('사람', 10);
    assert.ok(peopleGraph.every(record => record.graphRelation), 'a single-node query returns bounded actual edges without calling the broken MCP path formatter');
  } finally {
    await retrieval.close();
  }
});

test('an exact article lookup that does not exist is a not-found result, not a transport failure', { skip: legalIntegrationSkipReason }, async () => {
  const client = new McpStdioClient({
    command: process.env.LEGAL_PYTHON ?? env.legal.python,
    args: buildLegalMcpLaunchArgs(process.env.LEGAL_MCP_SCRIPT ?? env.legal.script, `${process.cwd()}/data/legal-rag-mcp-test.log`),
    cwd: env.legal.runtimeRoot,
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    startupTimeoutMs: env.legal.startupTimeoutMs,
    requestTimeoutMs: env.legal.requestTimeoutMs,
    maxResponseCharacters: env.legal.maxResponseCharacters,
    restartBudget: 1,
    stderrTailCharacters: 4_000
  });
  const retrieval = new LegalRetrievalService(client, {
    maxToolCalls: 4,
    maxRetrievalSteps: 2,
    maxQueryCharacters: env.legal.maxQueryCharacters,
    maxPrecedentCharacters: 4_000
  });
  try {
    const evidence = await retrieval.retrieve([{ kind: 'law-article', lawName: '존재하지않는법률', articleNumber: '제9999조' }]);
    assert.equal(evidence.sources.length, 0);
    assert.equal(evidence.failures.length, 1);
    assert.equal(evidence.failures[0]!.kind, 'not-found');
    assert.equal(evidence.status.laws.ready, true);
  } finally {
    await retrieval.close();
  }
});
