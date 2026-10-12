import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentService, type LegalAgentHooks } from '../src/application/agent-service.ts';
import { DocumentContentService } from '../src/application/document-content-service.ts';
import { DocumentService } from '../src/application/document-service.ts';
import { FileService } from '../src/application/file-service.ts';
import { LegalRequestRouter } from '../src/application/legal/legal-request-router.ts';
import { LegalWorkflow } from '../src/application/legal/legal-workflow.ts';
import { TaskEventBus } from '../src/application/task-event-bus.ts';
import { TaskService } from '../src/application/task-service.ts';
import { SqliteTaskRepository } from '../src/infrastructure/persistence/sqlite-task-repository.ts';
import { LegalRetrievalService, assignCitationIds } from '../src/infrastructure/legal/legal-retrieval-service.ts';
import { toLegalCapability } from '../src/application/capability-service.ts';
import type { LegalKnowledgeStatus, LegalSource } from '../src/domain/legal-source.ts';
import type { ModelProvider } from '../src/domain/model-provider.ts';
import type { FileStorage, ManagedFile } from '../src/domain/managed-file.ts';

class MemoryFiles implements FileStorage {
  private readonly entries = new Map<string, { metadata: ManagedFile; content: Uint8Array }>();
  async save(input: { name: string; mimeType: string; content: Uint8Array }): Promise<ManagedFile> {
    const id = `file_${this.entries.size + 1}`;
    const metadata = { id, name: input.name, mimeType: input.mimeType, bytes: input.content.length, createdAt: new Date().toISOString(), path: id };
    this.entries.set(id, { metadata, content: Uint8Array.from(input.content) });
    return metadata;
  }
  async get(id: string): Promise<ManagedFile | null> { return this.entries.get(id)?.metadata ?? null; }
  async read(id: string): Promise<{ metadata: ManagedFile; content: Uint8Array }> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('file not found');
    return { metadata: entry.metadata, content: Uint8Array.from(entry.content) };
  }
}

const STATUS: LegalKnowledgeStatus = {
  server: { name: 'korea-legal-rag', version: '0.2.1' },
  laws: { ready: true, documents: 81_445 },
  precedents: { ready: true, documents: 124_925 },
  vector: { ready: false, reason: 'disabled by USE_QDRANT=false (safe default)' },
  graph: { ready: true, nodes: 429_245, edges: 772_682 },
  ontology: { ready: true },
  okf: { ready: true },
  degraded: ['vector'],
  parsed: true
};

const lawSource: LegalSource = {
  citationId: 'L1',
  kind: 'law-article',
  corpus: 'law',
  recordId: 'law:민법#제398조',
  title: '민법',
  lawName: '민법',
  articleNumber: '제398조',
  articleLabel: '제398조 (배상액의 예정)',
  date: { kind: 'amendment', value: '2010.1.22' },
  statusMarkers: ['개정 2010.1.22'],
  excerpt: '법률명: 민법 ##### 제398조 (배상액의 예정) **①** 당사자는 채무불이행에 관한 손해배상액을 예정할 수 있다. <개정 2010.1.22>'
};

const precedentSource: LegalSource = {
  citationId: 'P1',
  kind: 'precedent',
  corpus: 'precedent',
  recordId: 'case:2013가합30895',
  title: '손해배상(기)',
  caseNumber: '2013가합30895',
  court: '인천지방법원',
  courtLevel: '하급심',
  caseCategory: '민사',
  officialUrl: 'https://www.law.go.kr/LSW/precInfoP.do?precSeq=179085',
  date: { kind: 'decision', value: '2015-07-03' },
  excerpt: "사건번호: 2013가합30895 법원명: 인천지방법원 선고일자: 2015-07-03 판결요지: 집단괴롭힘"
};

const graphSource: LegalSource = {
  citationId: 'G1',
  kind: 'graph',
  corpus: 'graph',
  recordId: 'graph:칼날',
  title: '칼날 관련 법률 관계',
  excerpt: '칼날 — 위해행위 관련 — 형법'
};

type StubRetrieval = {
  retrieval: LegalRetrievalService;
  calls: string[];
  close(): Promise<void>;
};

type StubStep = { kind: string; query?: string; lawName?: string; articleNumber?: string; caseNumber?: string; id?: string };

function stubRetrieval(sources: LegalSource[], failures: { step: string; kind: string; message: string }[] = []): StubRetrieval {
  const calls: string[] = [];
  const stub = {
    retrieve: async (steps: StubStep[]) => {
      calls.push(...steps.map(step => step.kind));
      return {
        sources,
        status: STATUS,
        degraded: [...STATUS.degraded, ...failures.map(f => f.kind)],
        failures,
        toolCalls: steps.length,
        maxToolCalls: 12,
        steps: [...steps],
        trace: steps.map(step => ({ step: step as never, results: sources.length }))
      };
    },
    knowledgeStatus: async () => STATUS,
    close: async () => undefined
  };
  return { retrieval: stub as unknown as LegalRetrievalService, calls, close: async () => undefined };
}

function buildAgent(input: {
  tasks: SqliteTaskRepository;
  files: MemoryFiles;
  model: ModelProvider;
  retrieval: LegalRetrievalService;
  claimVerification?: boolean;
  browser?: { searchMany: (queries: string[], limit: number) => Promise<never[]>; visitMany: (urls: string[]) => Promise<never[]> };
}) {
  const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
  const workflow = new LegalWorkflow({
    retrieval: input.retrieval,
    model: input.model,
    claimVerification: input.claimVerification,
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });
  const legal: LegalAgentHooks = { enabled: true, route: decision => router.route(decision), workflow };
  const browser = input.browser ?? { searchMany: async () => { throw new Error('web search is offline'); }, visitMany: async () => [] };
  const documents = new DocumentService(input.files);
  const agent = new AgentService(
    input.tasks,
    input.model,
    browser as never,
    new DocumentContentService(input.files),
    documents,
    new TaskEventBus(),
    legal
  );
  return { agent, documents };
}

async function withWorkspace(work: (context: { tasks: SqliteTaskRepository; files: MemoryFiles; root: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workfolio-legal-'));
  const files = new MemoryFiles();
  const tasks = new SqliteTaskRepository(path.join(root, 'tasks.sqlite'));
  try {
    await work({ tasks, files, root });
  } finally {
    tasks.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('a simple legal question makes no planner call, no multi-agent call, and returns a citation-validated answer', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const modelCalls: string[] = [];
    const model: ModelProvider = {
      complete: async ({ system, user }) => {
        modelCalls.push(system);
        assert.ok(!system.includes('Return only valid JSON'), 'the direct path must not call the planner');
        assert.match(system, /판례는 기록에 적힌 사실관계와 판단 범위 안에서만 설명/);
        assert.match(system, /참조조문 표시는 해당 조문의 원문이나 공식 명칭을 입증하지 않습니다/);
        assert.match(system, /웹 기사는 보도된 사실·당사자 주장만 확인하는 자료입니다/);
        assert.match(system, /현재 시행·효력 여부를 증명하지 않습니다/);
        assert.match(user, /LEGAL EVIDENCE/);
        assert.match(user, /민법/);
        return '「해석」조문은 손해배상액의 예정이 가능합니다 [L1]. 개정 표기가 있는 조항입니다.';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    const stored = tasks.getTask(task.id);
    assert.equal(stored?.status, 'completed');
    assert.equal(modelCalls.length, 1, 'exactly one answer-model call');
    assert.deepEqual(stub.calls, ['law-article'], 'only the exact article tool runs');
    assert.deepEqual(stored?.steps.map(step => step.title), ['법령·판례 근거 확인', '근거 기반 답변 작성']);
    const artifact = tasks.artifacts(task.id)[0]!;
    assert.match(artifact.content, /## 답변/);
    assert.match(artifact.content, /\[L1\] 민법 제398조 \(배상액의 예정\)/);
    assert.match(artifact.content, /개정 표기 2010\.1\.22/);
    assert.match(artifact.content, /개정·선고 날짜만 확인했으며, 현재 시행·효력 여부는 별도로 확인하지 않았습니다/);
    assert.match(artifact.content, /### 사용한 검색 계층/);
    assert.match(artifact.content, /- 벡터 유사도 검색: 사용하지 않음/);
    assert.match(artifact.content, /- 계획 모델 호출: 미사용 \(결정적 라우팅으로 직접 조회\)/);
    assert.match(artifact.content, /- `get_law_article` — 민법 제398조 → 기록 1건/);
    assert.match(artifact.content, /- 법령 키워드 검색: 이번 작업에서 사용/);
    assert.match(artifact.content, /이번 작업에서는 조회하지 않음/);
    assert.match(artifact.content, /법률 자문이나 대리인이 아닙니다/);
    const answer = tasks.events(task.id).find(event => event.type === 'legal.answer');
    assert.ok(answer);
    const metadata = answer.metadata as { intent: string; path: string; plannerCalls: number; citations: { citationId: string; recordId: string }[]; sourceStatus: { currentness: string; degraded: string[]; ledger: { planner: { mode: string }; tools: { tool: string; results: number }[] } } };
    assert.equal(metadata.intent, 'article-lookup');
    assert.equal(metadata.path, 'direct');
    assert.equal(metadata.plannerCalls, 0);
    assert.equal(metadata.sourceStatus.currentness, 'record-dated');
    assert.deepEqual(metadata.sourceStatus.degraded, ['vector']);
    assert.equal(metadata.sourceStatus.ledger.planner.mode, 'not-used');
    assert.deepEqual(metadata.sourceStatus.ledger.tools, [{ tool: 'get_law_article', label: '조문 조회: 민법 제398조', query: '민법 제398조', results: 1 }]);
    assert.deepEqual(metadata.citations.map(citation => citation.citationId), ['L1']);
    assert.equal(metadata.citations[0]!.recordId, 'law:민법#제398조');
  });
});

test('a direct search with thin legal evidence adds a graph search using the untouched request', async () => {
  const originalPrompt = '  칼날로 다치면 어떤 법적 문제가 생기나요?  ';
  const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
  const decision = router.route({ prompt: originalPrompt });
  const calls: Array<Array<{ kind: string; query?: string }>> = [];
  const retrieval = {
    retrieve: async (steps: Array<{ kind: string; query?: string }>) => {
      calls.push(steps);
      if (steps[0]?.kind === 'graph') {
        return {
          sources: [{ ...graphSource, citationId: 'G1' }],
          status: STATUS,
          degraded: ['vector'],
          failures: [],
          toolCalls: 1,
          maxToolCalls: 12,
          steps,
          trace: [{ step: steps[0] as never, results: 1 }]
        };
      }
      return {
        sources: [{ ...lawSource, relevance: 0.5, termMatches: ['칼날'] }],
        status: STATUS,
        degraded: ['vector'],
        failures: [],
        toolCalls: 2,
        maxToolCalls: 12,
        steps,
        trace: steps.map(step => ({ step: step as never, results: 1 }))
      };
    }
  } as unknown as LegalRetrievalService;
  const workflow = new LegalWorkflow({
    retrieval,
    model: { complete: async () => { throw new Error('retrieval must not invoke a model'); } },
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });

  const evidence = await workflow.retrieve(decision, new AbortController().signal);
  const status = workflow.executionStatus(evidence, decision);

  assert.equal(calls.length, 2, 'a thin direct search should make one bounded graph enrichment call');
  assert.equal(calls[1]![0]!.kind, 'graph');
  assert.equal(calls[1]![0]!.query, originalPrompt);
  assert.deepEqual(evidence.sources.map(source => source.citationId), ['L1', 'G1']);
  assert.equal(evidence.toolCalls, 3);
  assert.equal(status.ledger.layers.find(layer => layer.id === 'graph')?.state, 'used');
});

test('direct graph enrichment is skipped when enough legal evidence is already available', async () => {
  const calls: Array<Array<{ kind: string }>> = [];
  const retrieval = {
    retrieve: async (steps: Array<{ kind: string }>) => {
      calls.push(steps);
      return {
        sources: [lawSource, precedentSource],
        status: STATUS,
        degraded: ['vector'],
        failures: [],
        toolCalls: steps.length,
        maxToolCalls: 12,
        steps,
        trace: steps.map(step => ({ step: step as never, results: 1 }))
      };
    }
  } as unknown as LegalRetrievalService;
  const workflow = new LegalWorkflow({
    retrieval,
    model: { complete: async () => { throw new Error('retrieval must not invoke a model'); } },
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });
  const decision = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 }).route({ prompt: '칼날로 다치면 어떤 법적 문제가 생기나요?' });

  const evidence = await workflow.retrieve(decision, new AbortController().signal);

  assert.equal(calls.length, 1);
  assert.equal(evidence.toolCalls, 2);
  assert.equal(evidence.steps.some(step => step.kind === 'graph'), false);
});

test('graph relationships alone are not promoted when lexical retrieval found no legal record', async () => {
  const calls: Array<Array<{ kind: string }>> = [];
  const retrieval = {
    retrieve: async (steps: Array<{ kind: string }>) => {
      calls.push(steps);
      return {
        sources: [],
        status: STATUS,
        degraded: ['vector'],
        failures: [],
        toolCalls: steps.length,
        maxToolCalls: 12,
        steps,
        trace: steps.map(step => ({ step: step as never, results: 0 }))
      };
    }
  } as unknown as LegalRetrievalService;
  const workflow = new LegalWorkflow({
    retrieval,
    model: { complete: async () => { throw new Error('retrieval must not invoke a model'); } },
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });
  const decision = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 }).route({ prompt: '불분명한 법적 쟁점' });

  const evidence = await workflow.retrieve(decision, new AbortController().signal);

  assert.equal(calls.length, 1);
  assert.equal(evidence.sources.length, 0);
  assert.equal(evidence.steps.some(step => step.kind === 'graph'), false);
});

test('orchestrated retrieval stays within the planner-selected steps', async () => {
  const calls: Array<Array<{ kind: string }>> = [];
  const retrieval = {
    retrieve: async (steps: Array<{ kind: string }>) => {
      calls.push(steps);
      return {
        sources: [{ ...lawSource, relevance: 0.5, termMatches: ['위약금'] }],
        status: STATUS,
        degraded: ['vector'],
        failures: [],
        toolCalls: steps.length,
        maxToolCalls: 12,
        steps,
        trace: steps.map(step => ({ step: step as never, results: 1 }))
      };
    }
  } as unknown as LegalRetrievalService;
  const workflow = new LegalWorkflow({
    retrieval,
    model: { complete: async () => { throw new Error('retrieval must not invoke a model'); } },
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });
  const plan = {
    title: '위약금 검토',
    issue: '계약상 위약금',
    retrievalSteps: [{ kind: 'search-laws' as const, query: '위약금', limit: 5 }],
    draft: false,
    needsWeb: false,
    webQueries: []
  };

  const evidence = await workflow.retrieve(plan, new AbortController().signal);

  assert.equal(calls.length, 1);
  assert.equal(evidence.toolCalls, 1);
  assert.equal(evidence.steps.some(step => step.kind === 'graph'), false);
});

test('an unavailable optional graph search preserves primary evidence and records the failure', async () => {
  let calls = 0;
  const retrieval = {
    retrieve: async (steps: Array<{ kind: string; query?: string }>) => {
      calls += 1;
      if (steps[0]?.kind === 'graph') throw new Error('graph unavailable');
      return {
        sources: [{ ...lawSource, relevance: 0.5, termMatches: ['칼날'] }],
        status: STATUS,
        degraded: ['vector'],
        failures: [],
        toolCalls: steps.length,
        maxToolCalls: 12,
        steps,
        trace: steps.map(step => ({ step: step as never, results: 1 }))
      };
    }
  } as unknown as LegalRetrievalService;
  const workflow = new LegalWorkflow({
    retrieval,
    model: { complete: async () => { throw new Error('retrieval must not invoke a model'); } },
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });
  const decision = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 }).route({ prompt: '칼날로 다치면 어떤 법적 문제가 생기나요?' });

  const evidence = await workflow.retrieve(decision, new AbortController().signal);

  assert.equal(calls, 2);
  assert.deepEqual(evidence.sources.map(source => source.citationId), ['L1']);
  assert.equal(evidence.toolCalls, 3);
  assert.equal(evidence.failures.at(-1)?.kind, 'tool-error');
  assert.match(evidence.failures.at(-1)?.message ?? '', /graph unavailable/);
  assert.equal(evidence.trace.at(-1)?.results, 0);
});

test('the answer citation list excludes retrieved records that the answer did not cite', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const model: ModelProvider = { complete: async ({ system }) => {
      if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
      return '민법 제398조는 손해배상액을 미리 정할 수 있도록 합니다 [L1].';
    } };
    const stub = stubRetrieval([lawSource, precedentSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    const answer = tasks.events(task.id).find(event => event.type === 'legal.answer');
    const metadata = answer?.metadata as { citations: { citationId: string }[] };
    assert.deepEqual(metadata.citations.map(citation => citation.citationId), ['L1']);
    assert.doesNotMatch(tasks.artifacts(task.id)[0]!.content, /\[P1\]/);
  });
});

test('a multi-law comparison invokes the planner once and stays inside the retrieval bounds', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    let plannerCalls = 0;
    let answerCalls = 0;
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) {
          plannerCalls += 1;
          return JSON.stringify({
            title: '위약금과 손해배상 예정 비교',
            issue: '두 제도의 요건 차이',
            queries: [
              { corpus: 'law', query: '위약금 감액', limit: 5 },
              { corpus: 'precedent', query: '위약금 감액 판례', limit: 3 },
              { corpus: 'graph', query: '위약금', limit: 2 }
            ],
            articles: [],
            caseNumbers: [],
            draft: false,
            webQueries: []
          });
        }
        answerCalls += 1;
        return '쟁점 1: 위약금은 약정에 따른 손해배상 예정입니다 [L1].\n\n쟁점 2: 유사 판례가 있습니다 [P1].';
      }
    };
    const stub = stubRetrieval([lawSource, precedentSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('위약금과 손해배상 예정의 차이를 비교해 주세요? 그리고 각각의 판례도 알려 주세요.');
    await agent.run(task.id);
    await agent.drain();
    const stored = tasks.getTask(task.id);
    assert.equal(stored?.status, 'completed');
    assert.equal(plannerCalls, 1);
    assert.equal(answerCalls, 1);
    assert.deepEqual(stub.calls, ['search-laws', 'search-precedents', 'graph']);
    assert.ok(stub.calls.length <= 12, 'bounded tool calls');
    assert.deepEqual(stored?.steps.map(step => step.title), ['검색 계획 수립', '제한된 근거 수집', '근거 검증', '근거 기반 답변 작성']);
    const answer = tasks.events(task.id).find(event => event.type === 'legal.answer');
    assert.equal((answer?.metadata as { path: string }).path, 'orchestrated');
    assert.equal((answer?.metadata as { plannerCalls: number }).plannerCalls, 1);
  });
});

test('a simple first draft stays on the direct path and is labeled as a draft', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const uploaded = await new FileService(files).uploadBase64({ name: '계약서.txt', mimeType: 'text/plain', base64: Buffer.from('임대차 계약 조건: 보증금 1억, 월세 50만원.', 'utf8').toString('base64') });
    let plannerCalls = 0;
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) plannerCalls += 1;
        return '## 초안\n\n통보 문구 초안입니다 [D1]. 관련 근거 조문 [L1]을 함께 확인하세요.';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('임대차계약 해지 통보문 초안을 작성해 주세요. 임대인은 홍길동입니다.', undefined, [uploaded.id]);
    await agent.run(task.id);
    await agent.drain();
    const stored = tasks.getTask(task.id);
    assert.equal(stored?.status, 'completed');
    assert.equal(plannerCalls, 0);
    const answer = tasks.events(task.id).find(event => event.type === 'legal.answer');
    const metadata = answer?.metadata as { intent: string; path: string; draft: boolean };
    assert.equal(metadata.intent, 'legal-draft');
    assert.equal(metadata.path, 'direct');
    assert.match(tasks.artifacts(task.id)[0]!.content, /초안/);
  });
});

test('an explicitly document-mode task never starts the legal retrieval process', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    let retrievalCalls = 0;
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) return JSON.stringify({ title: '주간 보고', searchQueries: [], outline: [] });
        if (system.startsWith('Analyze the user request')) return '요약 내용입니다.';
        return '# 주간 보고\n\n요약 내용입니다.';
      }
    };
    const counting = { retrieve: async () => { retrievalCalls += 1; throw new Error('legal retrieval must not run'); }, knowledgeStatus: async () => STATUS, close: async () => undefined } as unknown as LegalRetrievalService;
    const { agent } = buildAgent({ tasks, files, model, retrieval: counting });
    const task = tasks.createTask('주간 판매 요약 보고서를 작성해 주세요.', undefined, [], [], 'document');
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.equal(retrievalCalls, 0);
    assert.equal(tasks.events(task.id).some(event => event.type === 'legal.routed'), false);
  });
});

test('questions are answered briefly while drafts keep their full length', async () => {
  const systems: string[] = [];
  const run = async (prompt: string): Promise<void> => withWorkspace(async ({ tasks, files }) => {
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        systems.push(system);
        return '근거에 따른 설명입니다 [L1].';
      }
    };
    const { agent } = buildAgent({ tasks, files, model, retrieval: stubRetrieval([lawSource]).retrieval });
    const task = tasks.createTask(prompt);
    await agent.run(task.id);
    await agent.drain();
  });
  await run('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
  await run('민법 제398조에 따른 손해배상 청구 서면 초안을 작성해 주세요.');
  const answers = systems.filter(system => system.includes('대한민국 법률 정보'));
  assert.ok(answers.length >= 2, 'both runs wrote an answer');
  assert.match(answers[0]!, /간결하게 쓰세요/, 'a question gets the concision rule');
  assert.doesNotMatch(answers[answers.length - 1]!, /간결하게 쓰세요/, 'a draft keeps its full length');
});

test('a draft that keeps naming law that was never retrieved is replaced by an answer within the retrieved evidence', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        return '형법 제314조와 개인정보보호법 제28조, 부정경쟁방지법 제2조가 함께 문제됩니다 [L1].';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed', String(tasks.getTask(task.id)?.error));
    const artifact = tasks.artifacts(task.id)[0]!;
    assert.match(artifact.content, /확보한 근거 범위/);
    assert.doesNotMatch(artifact.content, /형법 제314조|부정경쟁방지법 제2조/);
  });
});

test('an answer that invents a citation is repaired once and then rejected', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    let answers = 0;
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        answers += 1;
        return answers === 1 ? '존재하지 않는 근거를 인용합니다 [L9].' : '여전히 잘못된 인용입니다 [L9].';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    const stored = tasks.getTask(task.id);
    assert.equal(stored?.status, 'failed');
    assert.match(String(stored?.error), /legal answer validation failed/);
    assert.match(String(stored?.error), /L9/, 'the rejection names the unsupported citation');
    assert.equal(tasks.artifacts(task.id).length, 0);
    assert.equal(answers, 2, 'one repair pass, then rejection');
  });
});

test('a generic no-records placeholder is repaired before an answer is published', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    let answers = 0;
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        answers += 1;
        return answers === 1
          ? '확인된 기록이 없습니다.'
          : '민법 제398조는 손해배상액을 미리 정할 수 있도록 합니다 [L1].';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.match(tasks.artifacts(task.id)[0]!.content, /민법 제398조는 손해배상액을 미리 정할 수 있도록 합니다 \[L1\]/);
    assert.equal(answers, 2, 'one repair pass replaces the placeholder');
  });
});

test('a generic no-records placeholder is never published after a failed repair', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    let answers = 0;
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        answers += 1;
        return '확인된 기록이 없습니다.';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'failed');
    assert.match(String(tasks.getTask(task.id)?.error), /no substantive answer/);
    assert.equal(tasks.artifacts(task.id).length, 0);
    assert.equal(answers, 2, 'the answer gets one repair attempt before failure');
  });
});

test('an answer with no inline citation is published with an explicit coverage warning', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    let answers = 0;
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        answers += 1;
        return '확인된 조문이 이 쟁점과 직접 맞지 않아 일반적인 안내만 드립니다.';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    const stored = tasks.getTask(task.id);
    assert.equal(stored?.status, 'completed', 'an uncited but honest answer is not a failure');
    const content = tasks.artifacts(task.id)[0]!.content;
    assert.match(content, /답변 본문에서 확인된 근거를 특정하지 못했습니다/);
    assert.match(content, /답변 본문에서 확인 근거로 인용한 자료가 없습니다/);
    assert.doesNotMatch(content, /\[L1\] 민법 제398조/, 'uncited search hits are not presented as supporting evidence');
    const metadata = tasks.events(task.id).find(event => event.type === 'legal.answer')?.metadata as { sourceStatus: { cited: number; retrieved: number } };
    assert.equal(metadata.sourceStatus.cited, 0);
    assert.equal(metadata.sourceStatus.retrieved, 1);
    assert.equal(answers, 1, 'no repair pass is needed when nothing is invented');
  });
});

test('a bare citation handle is normalized instead of failing the answer', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        return '조문 L1은 손해배상액의 정지를 허용합니다.';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.match(tasks.artifacts(task.id)[0]!.content, /조문 \[L1\]은/);
  });
});

test('a direct answer that is repaired into a valid citation completes', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    let answers = 0;
    const model: ModelProvider = {
      complete: async ({ system, user }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        answers += 1;
        if (answers === 1) return '근거 없이 단정합니다 [L7].';
        assert.match(user, /REPAIR REQUIRED/);
        return '수정된 답변입니다 [L1].';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.match(tasks.artifacts(task.id)[0]!.content, /수정된 답변입니다 \[L1\]/);
  });
});

test('a currentness claim with only an amendment date is rejected', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    let answers = 0;
    const model: ModelProvider = {
      complete: async () => {
        answers += 1;
        return '현재 시행 중인 조항입니다 [L1].';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    const stored = tasks.getTask(task.id);
    assert.equal(stored?.status, 'failed');
    assert.match(String(stored?.error), /최신성/);
    assert.equal(answers, 2);
  });
});

test('a legal index that returns nothing produces an explicit no-evidence answer instead of invented law', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    let answers = 0;
    const model: ModelProvider = {
      complete: async () => {
        answers += 1;
        throw new Error('synthesis must not run without evidence');
      }
    };
    const stub = stubRetrieval([]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('별기법 제999조는 어떻게 정해져 있나요?');
    await agent.run(task.id);
    await agent.drain();
    const stored = tasks.getTask(task.id);
    assert.equal(stored?.status, 'completed');
    const content = tasks.artifacts(task.id)[0]!.content;
    assert.match(content, /확인된 근거가 없으므로 법적 결론, 조문 번호 또는 판례 내용을 추정해 답하지 않겠습니다/);
    assert.doesNotMatch(content, /민법 제55조|e-Laws|불법행위/);
    assert.match(content, /확인된 법령·판례 기록이 없습니다/);
    assert.match(content, /다시 시도하는 방법/);
    assert.match(content, /최신성: 로컬 색인이 현행 여부를 확인해 주지 않습니다/);
    const metadata = tasks.events(task.id).find(event => event.type === 'legal.answer')?.metadata as { sourceStatus: { currentness: string; retrieved: number } };
    assert.equal(metadata.sourceStatus.currentness, 'unverified');
    assert.equal(metadata.sourceStatus.retrieved, 0);
    assert.equal(answers, 0, 'no-evidence responses are deterministic and do not call the model');
  });
});

test('an exact lookup that finds no record fails with an actionable message', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const model: ModelProvider = { complete: async () => '이 답변은 사용되지 않습니다.' };
    const stub = stubRetrieval([], [{ step: '조문 조회: 별기법 제999조', kind: 'not-found', message: 'law article not found: 별기법 제999조' }]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('별기법 제999조는 어떻게 정해져 있나요?');
    await agent.run(task.id);
    await agent.drain();
    const stored = tasks.getTask(task.id);
    assert.equal(stored?.status, 'failed');
    assert.match(String(stored?.error), /찾지 못했습니다/);
    assert.equal(tasks.artifacts(task.id).length, 0);
  });
});

test('an unavailable legal index surfaces an accurate failure state', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const model: ModelProvider = { complete: async () => '이 답변은 사용되지 않습니다.' };
    const broken = {
      retrieve: async () => {
        const error = new Error('process exited (code 1)');
        throw Object.assign(error, { kind: 'transport', name: 'LegalRetrievalError' });
      },
      close: async () => undefined
    } as unknown as LegalRetrievalService;
    const { agent } = buildAgent({ tasks, files, model, retrieval: broken });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    await agent.run(task.id);
    await agent.drain();
    const stored = tasks.getTask(task.id);
    assert.equal(stored?.status, 'failed');
    assert.match(String(stored?.error), /process exited/);
    assert.equal(tasks.artifacts(task.id).length, 0);
  });
});

test('failed retrieval with no evidence fails the task without publishing a diagnostic document', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const stub = stubRetrieval([], [{ step: '법령 검색: 질문 전문', kind: 'tool-error', message: 'query rejected' }]);
    const model: ModelProvider = { complete: async () => { throw new Error('must not synthesize failed retrieval'); } };
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('요청 내용을 확인해 주세요.');
    await agent.run(task.id);
    assert.equal(tasks.getTask(task.id)?.status, 'failed');
    assert.match(tasks.getTask(task.id)?.error ?? '', /query rejected/);
    assert.equal(tasks.artifacts(task.id).length, 0);
    assert.equal(tasks.events(task.id).some(event => event.type === 'legal.answer'), false);
  });
});

test('document diagnostics summarize long queries without repeating the original narrative', async () => {
  const prompt = '사용자 요청의 긴 사실관계 원문입니다. '.repeat(25);
  const decision = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 }).route({ prompt });
  const stub = stubRetrieval([]);
  const workflow = new LegalWorkflow({ retrieval: stub.retrieval, model: { complete: async () => '' }, limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 } });
  const evidence = await stub.retrieval.retrieve([{ kind: 'search-laws', query: prompt, limit: 5 }]);
  const output = workflow.buildOutput({ decision, title: '검토 결과', answer: '확인할 근거가 부족합니다.', evidence, sources: [], documents: [], toolCalls: 1 });
  assert.equal(output.markdown.includes(prompt), false);
  assert.equal(output.answer.includes(prompt), false);
  assert.equal(output.sourceStatus.ledger.tools[0]?.query, prompt, 'structured diagnostic data must retain the raw query');
});

test('a request that needs current public information also uses web search as an extra source', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const visited: string[] = [];
    const model: ModelProvider = {
      complete: async ({ system, user }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        assert.match(user, /WEB PAGES/);
        return '로컬 조문 [L1]과 공식 안내 [W1]을 함께 확인했습니다.';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const documents = new DocumentService(files);
    const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
    const workflow = new LegalWorkflow({
      retrieval: stub.retrieval,
      model,
      limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
    });
    const agent = new AgentService(
      tasks,
      model,
      { searchMany: async () => [], visitMany: async (urls: string[]) => { visited.push(...urls); return [{ title: '국가법령정보센터', url: urls[0]!, snippet: '공식 안내', content: '공식 안내 페이지 본문입니다.', retrievedAt: '2026-09-30T00:00:00.000Z', retrievalStatus: 'retrieved' as const }]; } } as never,
      new DocumentContentService(files),
      documents,
      new TaskEventBus(),
      { enabled: true, route: decision => router.route(decision), workflow }
    );
    const task = tasks.createTask('현재 시행 중인 위약금 감액 기준과 공식 링크를 알려 주세요.', undefined, [], ['https://www.law.go.kr/']);
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.deepEqual(visited, ['https://www.law.go.kr/']);
    const content = tasks.artifacts(task.id)[0]!.content;
    assert.match(content, /\[L1\]/);
    assert.match(content, /\[W1\] 국가법령정보센터/);
    assert.match(content, /https:\/\/www\.law\.go\.kr\//);
    assert.doesNotMatch(content, /선고 2026-09-30/, 'web retrieval timestamps are not court decision dates');
  });
});

test('a public web-search failure degrades a legal answer without discarding local evidence', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const model: ModelProvider = { complete: async ({ system, user }) => {
      if (!system.startsWith('Return only valid JSON')) assert.match(user, /SearXNG search request failed/);
      return '확인된 자료로는 구체적인 위법 여부를 판단할 수 없습니다.';
    } };
    const stub = stubRetrieval([lawSource]);
    const documents = new DocumentService(files);
    const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
    const workflow = new LegalWorkflow({
      retrieval: stub.retrieval,
      model,
      limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
    });
    const agent = new AgentService(
      tasks, model,
      { searchMany: async () => { throw new Error('SearXNG search request failed'); }, visitMany: async () => [] } as never,
      new DocumentContentService(files), documents, new TaskEventBus(),
      { enabled: true, route: decision => router.route(decision), workflow }
    );
    const task = tasks.createTask('현재 시행 중인 위약금 감액 기준과 공식 링크를 알려 주세요.');
    await agent.run(task.id);
    const retrievalEvent = tasks.events(task.id).find(event => event.type === 'legal.retrieval');
    const metadata = retrievalEvent?.metadata as { sourceStatus?: { ledger?: { tools: unknown[] } }; toolCalls?: number } | undefined;
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.ok(retrievalEvent, 'the retrieval trace must survive a failure in the next stage');
    assert.ok((metadata?.sourceStatus?.ledger?.tools.length ?? 0) > 0);
    assert.equal(metadata?.sourceStatus?.ledger?.tools.length, metadata?.toolCalls);
    assert.match(tasks.artifacts(task.id)[0]!.content, /SearXNG search request failed/);
  });
});

test('an unreadable user link is disclosed as unavailable and is not listed as verified evidence', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const url = 'https://example.com/article';
    const model: ModelProvider = { complete: async ({ system, user }) => {
      if (!system.startsWith('Return only valid JSON')) assert.match(user, /본문 텍스트를 충분히 확인하지 못했습니다/);
      return '링크 본문을 읽지 못해 구체적인 행위와 위법 여부를 확인할 수 없습니다.';
    } };
    const stub = stubRetrieval([lawSource]);
    const browser = {
      visitMany: async () => [{ title: '기사 제목', url, snippet: '', content: '', retrievedAt: '2026-10-01T06:38:54.171Z', retrievalStatus: 'unavailable' as const, retrievalError: '페이지 본문 텍스트를 충분히 확인하지 못했습니다.' }],
      searchMany: async () => []
    };
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval, browser });
    const task = tasks.createTask('첨부 링크의 내용을 객관적으로 판단했을때 카카오의 행동은 위법일까 위탁일까?', undefined, [], [url]);
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    const report = tasks.artifacts(task.id)[0]!.content;
    assert.match(report, /링크 https:\/\/example\.com\/article · 페이지 본문 텍스트를 충분히 확인하지 못했습니다/);
    assert.match(report, /답변 본문에서 확인 근거로 인용한 자료가 없습니다/);
    assert.doesNotMatch(report, /\[W1\] 기사 제목/);
    assert.doesNotMatch(report, /선고 2026-10-01T06:38:54/);
  });
});

test('cancelling a legal task stops the run and publishes no artifact', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    let release!: (value: string) => void;
    const pendingAnswer = new Promise<string>(resolve => { release = resolve; });
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        entered();
        return pendingAnswer;
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?');
    const running = agent.run(task.id);
    await reached;
    agent.cancel(task.id);
    release('취소된 답변 [L1].');
    await running;
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'cancelled');
    assert.equal(tasks.artifacts(task.id).length, 0);
  });
});

test('an uploaded file stays per-task evidence and never becomes a legal index record', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const uploaded = await new FileService(files).uploadBase64({ name: '사유서.txt', mimeType: 'text/plain', base64: Buffer.from('개인 사정으로 계약 해지를 원합니다.', 'utf8').toString('base64') });
    const stub = stubRetrieval([lawSource]);
    const model: ModelProvider = { complete: async ({ system, user }) => {
      if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
      assert.match(user, /사유서\.txt/);
      return '첨부 자료에 적힌 사정 [D1]과 관련 조문 [L1]을 확인했습니다.';
    } };
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('첨부한 사유서를 바탕으로 해지 가능 여부를 알려 주세요.', undefined, [uploaded.id]);
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.deepEqual(stub.calls, ['search-laws', 'search-precedents'], 'uploads are never sent to the legal index');
    const answer = tasks.events(task.id).find(event => event.type === 'legal.answer')?.metadata as { citations: { citationId: string; corpus: string }[] };
    assert.deepEqual(answer.citations.map(citation => citation.citationId), ['L1', 'D1']);
    assert.equal(answer.citations[1]!.corpus, 'document');
  });
});

test('saved document revisions reuse the existing document workspace behaviour', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const model: ModelProvider = { complete: async ({ system }) => {
      if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
      return '초기 답변 [L1].';
    } };
    const stub = stubRetrieval([lawSource]);
    const { agent, documents } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const service = new TaskService(tasks, agent, new FileService(files), documents);
    const task = await service.create({ prompt: '민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?' });
    await agent.drain();
    const saved = await service.saveDocument(task.id, '# 손해배상 예정 안내\n\n수정된 본문 [L1].');
    assert.ok(saved.fileId);
    assert.equal(tasks.artifacts(task.id).length, 2);
    await service.revise(task.id, { kind: 'revision', message: '요약을 더 짧게 정리해 주세요.' });
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.equal(tasks.artifacts(task.id).length, 3);
    assert.equal(tasks.events(task.id).filter(event => event.type === 'task.completed').length, 2);
  });
});

test('an explicitly legal task overrides routing even for a non-legal sounding prompt', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const model: ModelProvider = {
      complete: async ({ system }) => {
        if (system.startsWith('Return only valid JSON')) throw new Error('planner must not run');
        return '근거를 확인했습니다 [L1].';
      }
    };
    const stub = stubRetrieval([lawSource]);
    const { agent } = buildAgent({ tasks, files, model, retrieval: stub.retrieval });
    const task = tasks.createTask('번역해 주세요', undefined, [], [], 'legal');
    assert.equal(task.workflow, 'legal');
    assert.equal(tasks.getTask(task.id)?.workflow, 'legal', 'the workflow choice survives a repository round trip');
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    assert.ok(tasks.events(task.id).some(event => event.type === 'legal.routed'));
    assert.deepEqual(stub.calls, ['search-laws', 'search-precedents']);
  });
});

test('citation handles stay stable and legal readiness is reported separately from the model key', () => {
  const capability = toLegalCapability({ enabled: true, root: 'C:/corpus', status: STATUS });
  assert.equal(capability.ready, true);
  assert.equal(capability.state, 'degraded');
  assert.equal(capability.vector.ready, false);
  assert.equal(capability.corpus.laws, 81_445);
  assert.equal(capability.degraded.includes('vector'), true);
  const disabled = toLegalCapability({ enabled: false, root: 'C:/corpus', status: STATUS });
  assert.equal(disabled.state, 'disabled');
  const unknown = toLegalCapability({ enabled: true, root: 'C:/corpus', status: null });
  assert.equal(unknown.ready, false);
  assert.equal(unknown.state, 'unknown');
  const sources = assignCitationIds([lawSource, precedentSource]);
  assert.deepEqual(sources.map(source => source.citationId), ['L1', 'P1']);
});

test('an issue that found nothing is retried with leading terms, while an errored one is repeated verbatim', async () => {
  const longQuery = '개인정보 유출 사고 통지 의무 과태료 형사처벌 요건 책임';
  const plan = { title: 't', issue: 'i', retrievalSteps: [{ kind: 'search-laws', query: longQuery }], draft: false, needsWeb: false, webQueries: [] };
  const run = async (failure: boolean) => {
    const calls: string[] = [];
    const retrieval = {
      retrieve: async (steps: Array<{ kind: string; query?: string }>) => {
        calls.push(steps[0]!.query!);
        const hit = calls.length === 2;
        return {
          sources: hit ? [{ ...lawSource, citationId: 'L1' }] : [],
          status: STATUS,
          steps,
          trace: [{ step: steps[0]!, results: hit ? 1 : 0 }],
          failures: !hit && failure ? [{ step: `법령 검색: ${steps[0]!.query!}`, kind: 'transport', message: 'x' }] : [],
          degraded: [],
          toolCalls: 1,
          maxToolCalls: 12
        };
      }
    };
    const workflow = new LegalWorkflow({
      retrieval: retrieval as never,
      model: { complete: async () => '' },
      limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
    });
    const evidence = await workflow.retrieve(plan as never, new AbortController().signal);
    return { calls, evidence };
  };
  const empty = await run(false);
  assert.equal(empty.calls.length, 2);
  assert.equal(empty.calls[1], '개인정보 유출 사고 통지');
  assert.deepEqual(empty.evidence.sources.map(source => source.citationId), ['L1']);
  const errored = await run(true);
  assert.equal(errored.calls[1], longQuery, 'a failed step is retried exactly as planned');
});

test('a weak direct search is re-run once with statutory-term queries, and a failed rewrite changes nothing', async () => {
  const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
  const decision = router.route({ prompt: '회사에서 갑자기 잘렸어요 어떻게 하나요?' });
  const calls: string[] = [];
  const retrieval = {
    retrieve: async (steps: StubStep[]) => {
      calls.push(...steps.map(step => `${step.kind}:${step.query ?? ''}`));
      const rewritten = steps.some(step => step.query === '근로기준법 해고 제한');
      return {
        sources: rewritten ? [{ ...lawSource, relevance: 1 }] : [{ ...lawSource, relevance: 0.2 }],
        status: STATUS, degraded: [], failures: [], toolCalls: steps.length, maxToolCalls: 12, steps,
        trace: steps.map(step => ({ step: step as never, results: 1 }))
      };
    }
  } as unknown as LegalRetrievalService;
  const limits = { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 };
  const good = new LegalWorkflow({ queryRewrite: true, retrieval, model: { complete: async () => '```json\n{"queries":["근로기준법 해고 제한","회사에서 갑자기 잘렸어요 어떻게 하나요?"]}\n```' }, limits });
  const evidence = await good.retrieve(decision, new AbortController().signal);
  assert.ok(calls.includes('search-laws:근로기준법 해고 제한'), 'the rewritten query is searched');
  assert.equal(calls.filter(call => call.includes('근로기준법 해고 제한')).length, 1);
  assert.equal(evidence.toolCalls, calls.length);

  calls.length = 0;
  const broken = new LegalWorkflow({ queryRewrite: true, retrieval, model: { complete: async () => 'not json' }, limits });
  const unchanged = await broken.retrieve(decision, new AbortController().signal);
  assert.ok(unchanged.sources.length > 0);
  assert.equal(calls.some(call => call.includes('근로기준법')), false);
});

test('the rewrite also searches precedents for the doctrinal terms of a question that asks how two concepts differ', async () => {
  const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
  const decision = router.route({ prompt: '위약벌과 손해배상 예정액은 어떻게 다른가요?' });
  const calls: string[] = [];
  const retrieval = {
    retrieve: async (steps: StubStep[]) => {
      calls.push(...steps.map(step => `${step.kind}:${step.query ?? ''}`));
      return { sources: [{ ...lawSource, relevance: 0.2 }], status: STATUS, degraded: [], failures: [], toolCalls: steps.length, maxToolCalls: 12, steps, trace: steps.map(step => ({ step: step as never, results: 1 })) };
    }
  } as unknown as LegalRetrievalService;
  const limits = { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 };
  const workflow = new LegalWorkflow({ queryRewrite: true, retrieval, limits, model: { complete: async () => '{"queries":["손해배상 예정"],"precedentQueries":["위약벌 손해배상예정 구별"]}' } });
  await workflow.retrieve(decision, new AbortController().signal);
  assert.ok(calls.includes('search-precedents:위약벌 손해배상예정 구별'), 'the concept-distinguishing precedent query is searched');
  assert.ok(calls.includes('search-laws:손해배상 예정'));
});

test('query rewriting is off unless enabled, so direct lookups never call the model', async () => {
  const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
  const decision = router.route({ prompt: '회사에서 갑자기 잘렸어요 어떻게 하나요?' });
  const stub = stubRetrieval([{ ...lawSource, relevance: 0.2 }]);
  const workflow = new LegalWorkflow({
    retrieval: stub.retrieval,
    model: { complete: async () => { throw new Error('the model must not be called when rewriting is disabled'); } },
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });
  await workflow.retrieve(decision, new AbortController().signal);
  assert.equal(stub.calls.filter(kind => kind === 'search-laws').length, 1);
});

test('claim verification drops sentences their cited record does not support, and fails open when the check cannot run', async () => {
  const limits = { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 };
  const sources = [{ ...lawSource, citationId: 'L1', excerpt: '손해배상액의 예정이 부당히 과다한 경우 법원은 적당히 감액할 수 있다.' }];
  const answer = '법원은 예정액을 감액할 수 있습니다 [L1].\n위약벌은 언제나 형사처벌 대상입니다 [L1].\n결론적으로 감액이 가능합니다 [L1].';
  const retrieval = {} as unknown as LegalRetrievalService;
  const signal = new AbortController().signal;
  const prompts: string[] = [];

  const judge = new LegalWorkflow({ claimVerification: true, retrieval, limits, model: { complete: async ({ user }) => { prompts.push(user); return '{"unsupported":[2]}'; } } });
  const verified = await judge.verifyClaims(answer, sources, signal);
  assert.equal(verified.removed, 1);
  assert.equal(verified.checked, true);
  assert.equal(verified.answer, '법원은 예정액을 감액할 수 있습니다 [L1].\n결론적으로 감액이 가능합니다 [L1].');
  assert.match(prompts[0]!, /부당히 과다한 경우/, 'the cited record text is shown to the judge');

  const broken = new LegalWorkflow({ claimVerification: true, retrieval, limits, model: { complete: async () => 'not json' } });
  assert.deepEqual(await broken.verifyClaims(answer, sources, signal), { answer, removed: 0, checked: false });

  const allFlagged = new LegalWorkflow({ claimVerification: true, retrieval, limits, model: { complete: async () => '{"unsupported":[1,2,3]}' } });
  const rejected = await allFlagged.verifyClaims(answer, sources, signal);
  assert.equal(rejected.removed, 3, 'unsupported claims are never restored');
  assert.doesNotMatch(rejected.answer, /위약벌|감액이 가능합니다|\[L1\]/);
  assert.ok(rejected.answer.trim().length > 0, 'a useful evidence-limitation explanation remains');
  assert.equal(judge.assertPublishable(rejected.answer, sources).citationless, true);

  const off = new LegalWorkflow({ retrieval, limits, model: { complete: async () => { throw new Error('model must not be called when verification is off'); } } });
  assert.deepEqual(await off.verifyClaims(answer, sources, signal), { answer, removed: 0, checked: false });
});

test('a verifier false alarm on a sentence that quotes its record is ignored', async () => {
  const limits = { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 };
  const quote = { ...lawSource, citationId: 'L1', excerpt: '고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다.' };
  const answer = '고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다 [L1].';
  const workflow = new LegalWorkflow({ claimVerification: true, retrieval: {} as LegalRetrievalService, limits, model: { complete: async () => '{"unsupported":[1]}' } });
  const result = await workflow.verifyClaims(answer, [quote], new AbortController().signal);
  assert.deepEqual(result, { answer, removed: 0, checked: true });
});

test('verification calls the model only for sentences that do not quote their record', async () => {
  const limits = { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 };
  const quote = { ...lawSource, citationId: 'L1', excerpt: '고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다.' };
  const quoted = '고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다 [L1].';
  const never = new LegalWorkflow({ claimVerification: true, retrieval: {} as LegalRetrievalService, limits, model: { complete: async () => { throw new Error('a fully quoted answer must not call the model'); } } });
  assert.deepEqual(await never.verifyClaims(quoted, [quote], new AbortController().signal), { answer: quoted, removed: 0, checked: true });

  const seen: string[] = [];
  const mixed = new LegalWorkflow({ claimVerification: true, retrieval: {} as LegalRetrievalService, limits, model: { complete: async ({ user }) => { seen.push(user); return '{"unsupported":[1]}'; } } });
  const paraphrase = '그러므로 모든 계약 분쟁에서 항상 배상이 면제됩니다 [L1].';
  const result = await mixed.verifyClaims(`${quoted}
${paraphrase}`, [quote], new AbortController().signal);
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0]!.split('SENTENCES')[1]!, /고의 또는 과실/, 'the quoted sentence is not sent to the model');
  assert.match(seen[0]!, /항상 배상이 면제/);
  assert.equal(result.removed, 1);
  assert.match(result.answer, /고의 또는 과실/);
  assert.doesNotMatch(result.answer, /항상 배상이 면제/);
});

test('citation labels written after the period are neither sent to the verifier nor removed by it', async () => {
  const limits = { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 };
  const record = { ...lawSource, citationId: 'L1', excerpt: '법원은 손해배상 예정액이 부당하게 과다한 경우 적당히 감액할 수 있다.' };
  const answer = '대법원은 위약벌의 약정을 손해배상 예정과 구별해 법원이 마음대로 줄일 수 없다고 판단했다. [L1]';
  const seen: string[] = [];
  const workflow = new LegalWorkflow({ claimVerification: true, retrieval: {} as LegalRetrievalService, limits, model: { complete: async ({ user }) => { seen.push(user); return '{"unsupported":[1]}'; } } });
  const result = await workflow.verifyClaims(answer, [record], new AbortController().signal);
  const sentences = seen[0]!.split('SENTENCES')[1]!.trim().split('\n');
  assert.equal(sentences.length, 1, 'the label is part of its sentence, not a sentence of its own');
  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.answer, /^\[L1\]$/m);
});

test('malformed claim-verification responses never claim successful verification', async () => {
  const limits = { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 };
  const answer = '근거를 검토했습니다 [L1].';
  for (const reply of ['{}', 'null', '[]', '{"unsupported":null}', '{"unsupported":["1"]}', '{"unsupported":[2]}']) {
    const workflow = new LegalWorkflow({ claimVerification: true, retrieval: {} as LegalRetrievalService, limits, model: { complete: async () => reply } });
    const result = await workflow.verifyClaims(answer, [lawSource], new AbortController().signal);
    assert.equal(result.checked, false, reply);
  }
  const uncited = new LegalWorkflow({ claimVerification: true, retrieval: {} as LegalRetrievalService, limits, model: { complete: async () => { throw new Error('no cited claims to verify'); } } });
  assert.equal((await uncited.verifyClaims('추가 사실관계를 확인해 주세요.', [lawSource], new AbortController().signal)).checked, false);
});

test('a task whose claims all fail verification publishes only the evidence limitation, not the rejected answer', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const rejectedAnswer = '이 행위는 언제나 형사처벌 대상입니다 [L1].';
    const model: ModelProvider = { complete: async ({ system }) => system.startsWith('You audit') ? '{"unsupported":[1]}' : rejectedAnswer };
    const { agent } = buildAgent({ tasks, files, model, retrieval: stubRetrieval([lawSource]).retrieval, claimVerification: true });
    const task = tasks.createTask('민법 제398조를 설명해 주세요.');
    await agent.run(task.id);
    await agent.drain();
    assert.equal(tasks.getTask(task.id)?.status, 'completed');
    const artifact = tasks.artifacts(task.id)[0]!;
    assert.match(artifact.content, /법적 결론을 제시할 수 없습니다/);
    assert.doesNotMatch(artifact.content, /언제나 형사처벌/);
    const answerEvent = tasks.events(task.id).find(event => event.type === 'legal.answer');
    assert.deepEqual(answerEvent?.metadata?.citations, []);
  });
});

test('rewrite also looks up proposed articles, and a proposed article that does not exist is discarded silently', async () => {
  const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
  const decision = router.route({ prompt: '회사에서 갑자기 잘렸어요 어떻게 하나요?' });
  const steps: StubStep[] = [];
  const retrieval = {
    retrieve: async (requested: StubStep[]) => {
      steps.push(...requested);
      const article = requested.find(step => step.kind === 'law-article');
      return {
        sources: article ? [{ ...lawSource, lawName: '근로기준법', articleNumber: '제23조' }] : [],
        status: STATUS, degraded: [],
        failures: requested.filter(step => step.kind === 'law-article' && step.lawName === '없는법').map(step => ({ step: `${step.lawName}`, kind: 'not-found', message: '조문을 찾지 못했습니다.' })),
        toolCalls: requested.length, maxToolCalls: 12, steps: requested,
        trace: requested.map(step => ({ step: step as never, results: 0 }))
      };
    }
  } as unknown as LegalRetrievalService;
  const reply = '{"queries":["해고 제한"],"articles":[{"lawName":"근로기준법","articleNumber":"23"},{"lawName":"없는법","articleNumber":"제9조"},{"lawName":"","articleNumber":"제1조"},{"lawName":"민법","articleNumber":"abc"}]}';
  const workflow = new LegalWorkflow({
    queryRewrite: true, retrieval, model: { complete: async () => reply },
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });
  const evidence = await workflow.retrieve(decision, new AbortController().signal);
  const lookups = steps.filter(step => step.kind === 'law-article').map(step => `${step.lawName} ${step.articleNumber}`);
  assert.deepEqual(lookups, ['근로기준법 제23조', '없는법 제9조'], 'a bare number is normalised; blank law names and malformed numbers never reach retrieval');
  assert.equal(evidence.failures.some(failure => failure.kind === 'not-found'), false, 'the guessed missing article is not reported as a failure');
  assert.ok(evidence.sources.some(source => source.lawName === '근로기준법'));
});

test('relevance filtering drops clearly unrelated law records, keeps the rest, and fails open', async () => {
  const limits = { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 };
  const record = (id: number, title: string): LegalSource => ({ ...lawSource, citationId: `L${id}`, recordId: `law:${id}`, title, articleLabel: `제${id}조`, excerpt: `${title} 본문` });
  const sources = [record(1, '민법 불법행위'), record(2, '반도체집적회로의배치설계에관한법률'), record(3, '자동차손해배상보장법'), record(4, '식물신품종보호법')];
  const retrieval = {} as unknown as LegalRetrievalService;
  const signal = new AbortController().signal;
  const prompts: string[] = [];

  const filter = new LegalWorkflow({ relevanceFilter: true, retrieval, limits, model: { complete: async ({ user }) => { prompts.push(user); return '{"relevant":["L1","L3","L99"]}'; } } });
  const result = await filter.selectRelevantSources('교통사고 손해배상', sources, signal, false);
  assert.deepEqual(result.sources.map(source => source.citationId), ['L1', 'L3']);
  assert.equal(result.dropped, 2);
  assert.match(prompts[0]!, /교통사고 손해배상/);

  assert.equal((await filter.selectRelevantSources('x', sources, signal, true)).dropped, 0, 'a user-named article is never second-guessed');
  assert.equal((await filter.selectRelevantSources('x', sources.slice(0, 3), signal, false)).dropped, 0, 'small result sets are left alone');

  const unsure = new LegalWorkflow({ relevanceFilter: true, retrieval, limits, model: { complete: async () => '{"relevant":[]}' } });
  const empty = await unsure.selectRelevantSources('x', sources, signal, false);
  assert.equal(empty.dropped, 4, 'an explicit empty relevance result removes all unrelated candidates');
  assert.deepEqual(empty.sources, []);
  const broken = new LegalWorkflow({ relevanceFilter: true, retrieval, limits, model: { complete: async () => 'oops' } });
  assert.equal((await broken.selectRelevantSources('x', sources, signal, false)).sources.length, 4);
  const off = new LegalWorkflow({ retrieval, limits, model: { complete: async () => { throw new Error('model must not be called when the filter is off'); } } });
  assert.equal((await off.selectRelevantSources('x', sources, signal, false)).dropped, 0);
});

test('a wiki article fetch that fails once is retried, and a repeated failure is reported instead of vanishing', async () => {
  const limits = { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 };
  const wikiHints = { find: async () => [{ lawName: '민법', article: '제398조', title: '손해배상액의 예정' }], sourceUrlFor: async () => undefined };
  let fetches = 0;
  const flaky = {
    retrieve: async (steps: StubStep[]) => {
      fetches += 1;
      if (fetches === 1) throw new Error('legal retrieval process is starting');
      return { sources: [{ ...lawSource, citationId: 'L1' }], status: STATUS, degraded: [], failures: [], toolCalls: steps.length, maxToolCalls: 12, steps, trace: steps.map(step => ({ step: step as never, results: 1 })) };
    }
  } as unknown as LegalRetrievalService;
  const workflow = new LegalWorkflow({ retrieval: flaky, limits, wikiHints, model: { complete: async () => '' } });
  const base = { sources: [], status: STATUS, degraded: [], failures: [], toolCalls: 0, maxToolCalls: 12, steps: [], trace: [] } as never;
  const recovered = await workflow.addWikiHints('손해배상액의 예정', base, new AbortController().signal);
  assert.equal(fetches, 2, 'one retry');
  assert.equal(recovered.wikiHints, 1);

  const reports: string[] = [];
  const { runWithProgress } = await import('../src/shared/task-progress.ts');
  const broken = new LegalWorkflow({ retrieval: { retrieve: async () => { throw new Error('process down'); } } as unknown as LegalRetrievalService, limits, wikiHints, model: { complete: async () => '' } });
  const unchanged = await runWithProgress(report => reports.push(report.title), () => broken.addWikiHints('손해배상액의 예정', base, new AbortController().signal));
  assert.equal(unchanged.sources.length, 0);
  assert.ok(reports.includes('LLM Wiki 핵심 조문집 건너뜀'), 'the failure is visible in the task log');
});

test('wiki key-article hints are fetched from the corpus, deduplicated, and give the law its official link', async () => {
  const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
  const decision = router.route({ prompt: '회사에서 갑자기 해고당했어요 어떻게 하나요?' });
  const fetched: string[] = [];
  const retrieval = {
    retrieve: async (requested: StubStep[]) => {
      const articles = requested.filter(step => step.kind === 'law-article');
      fetched.push(...articles.map(step => `${step.lawName} ${step.articleNumber}`));
      return {
        sources: articles.filter(step => step.articleNumber !== '제27조').map(step => ({ ...lawSource, lawName: step.lawName, articleNumber: step.articleNumber, recordId: `law:${step.articleNumber}` })),
        status: STATUS, degraded: [],
        failures: articles.filter(step => step.articleNumber === '제27조').map(step => ({ step: `${step.lawName}`, kind: 'not-found', message: '없음' })),
        toolCalls: requested.length, maxToolCalls: 12, steps: requested,
        trace: requested.map(step => ({ step: step as never, results: step.articleNumber === '제27조' ? 0 : 1 }))
      };
    }
  } as unknown as LegalRetrievalService;
  const wikiHints = {
    find: async () => [
      { lawName: '근로기준법', article: '제23조', title: '해고 등의 제한' },
      { lawName: '근로기준법', article: '제26조', title: '해고의 예고' },
      { lawName: '근로기준법', article: '제27조', title: '해고사유 등의 서면통지' }
    ],
    sourceUrlFor: async (lawName: string) => (lawName === '근로기준법' ? 'https://www.law.go.kr/법령/근로기준법' : undefined)
  };
  const workflow = new LegalWorkflow({
    wikiHints, retrieval, model: { complete: async () => { throw new Error('wiki hints must not call the model'); } },
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });
  const evidence = await workflow.retrieve(decision, new AbortController().signal);
  assert.ok(fetched.includes('근로기준법 제23조') && fetched.includes('근로기준법 제26조'));
  assert.equal(evidence.wikiHints, 2, 'only articles that exist in the corpus are counted');
  assert.equal(evidence.failures.some(failure => failure.kind === 'not-found'), false);
  const wikiSources = evidence.sources.filter(source => source.lawName === '근로기준법');
  assert.ok(wikiSources.length >= 2 && wikiSources.every(source => source.officialUrl === 'https://www.law.go.kr/법령/근로기준법'));
  const ledger = workflow.executionStatus(evidence, decision).ledger;
  assert.equal(ledger.layers.find(layer => layer.id === 'wiki')?.state, 'used');
  assert.equal(ledger.layers.find(layer => layer.id === 'okf')?.state, 'used');

  const none = new LegalWorkflow({
    wikiHints: { find: async () => [], sourceUrlFor: async () => undefined }, retrieval, model: { complete: async () => '' },
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });
  const quiet = await none.retrieve(decision, new AbortController().signal);
  assert.equal(quiet.wikiHints, 0);
  assert.equal(none.executionStatus(quiet, decision).ledger.layers.find(layer => layer.id === 'wiki')?.state, 'ready');
});

test('the knowledge layers feed each other and every step shows up in the answer document', async () => {
  const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
  const decision = router.route({ prompt: '손해배상액의 예정이 너무 많으면 어떻게 되나요?' });
  const graphEdge = (caseFile: string): LegalSource => ({
    citationId: 'G1', kind: 'graph', corpus: 'graph', recordId: `graph:${caseFile}`, title: 'edge', excerpt: 'edge',
    graphRelation: { sourceId: 'precedent:1', sourceLabel: '손해배상', sourceType: 'Precedent', relation: 'CITES_ARTICLE', targetId: 'law:001706:article:398', targetLabel: '법률 제398조', targetType: 'Article', sourcePath: `민사/대법원/${caseFile}`, targetPath: 'kr/민법/법률.md' }
  });
  const precedent = (caseNumber: string, excerpt: string): LegalSource => ({
    citationId: 'P1', kind: 'precedent', corpus: 'precedent', recordId: `case:${caseNumber}`, title: '손해배상', caseNumber, court: '대법원', excerpt
  });
  const retrieval = {
    retrieve: async (steps: StubStep[]) => {
      const kind = steps[0]!.kind;
      const sources = kind === 'graph'
        ? [graphEdge('대법원_1993-04-23_92다41719.md'), graphEdge('대법원_1995-01-01_94다1.md')]
        : kind === 'precedent'
          ? steps.map(step => step.id === '92다41719'
            ? precedent('92다41719', '참조조문 민법 제398조 제2항 … 손해배상 예정액의 감액')
            : precedent(step.id!, '참조조문 없음, 다른 사건'))
          : [lawSource];
      return { sources, status: STATUS, degraded: [], failures: [], toolCalls: steps.length, maxToolCalls: 12, steps, trace: steps.map(step => ({ step: step as never, results: sources.length })) };
    }
  } as unknown as LegalRetrievalService;
  const knowledgeChain = {
    loadOntology: async () => (await import('../src/application/legal/legal-knowledge-chain.ts')).parseOntology(
      'legal:Precedent a rdfs:Class ;\n rdfs:subClassOf legal:LegalDocument .\nlegal:Article a rdfs:Class ;\n rdfs:subClassOf legal:LegalDocument .\nlegal:citesArticle a rdf:Property ;\n rdfs:domain legal:LegalDocument ;\n rdfs:range legal:Article .\n'
    ),
    loadOkf: async () => new Map([
      ['laws', { key: 'laws', type: 'Legal Corpus', title: 'Legal Corpus — Laws', resource: '../../data/legal/full' }],
      ['precedents', { key: 'precedents', type: 'Legal Corpus', title: 'Legal Corpus — Precedents' }],
      ['graph-index', { key: 'graph-index', type: 'Graph Index', title: 'Legal Relationship Graph' }]
    ])
  };
  const workflow = new LegalWorkflow({
    knowledgeChain, retrieval, model: { complete: async () => { throw new Error('the chain itself makes no model calls'); } },
    limits: { maxQueryCharacters: 300, orchestratedQueryLimit: 5, maxRetrievalSteps: 8, maxToolCalls: 12, maxPrecedentCharacters: 12_000, directSourceLimit: 6 }
  });
  const retrieved = await workflow.retrieve(decision, new AbortController().signal);
  assert.deepEqual(retrieved.chain?.map(stage => stage.id), ['rag'], 'retrieval alone does not walk the graph');
  // In the agent the graph runs after the relevance check, on the records that survived it.
  const evidence = await workflow.linkPrecedentsViaGraph(retrieved, new AbortController().signal);

  const linked = evidence.sources.find(source => source.caseNumber === '92다41719');
  assert.ok(linked, 'the precedent the graph found, and whose text cites the article, is added');
  assert.equal(evidence.sources.some(source => source.caseNumber === '94다1'), false, 'a precedent whose text does not cite the article is dropped');
  assert.equal(evidence.sources.some(source => source.corpus === 'graph'), false, 'graph edges are used for linking, not cited themselves');
  assert.ok(linked.provenance?.some(route => route.includes('citesArticle') && route.includes('민법 제398조') && route.includes('온톨로지')));
  assert.deepEqual(evidence.chain?.map(stage => stage.id), ['rag', 'graph', 'ontology']);

  const answer = `손해배상 예정액이 과다하면 감액될 수 있습니다 [L1]. 대법원도 같은 취지입니다 [${linked.citationId}].`;
  const output = workflow.buildOutput({
    decision, answer, evidence, sources: evidence.sources, documents: [], title: '테스트', toolCalls: evidence.toolCalls,
    agentStats: { filtered: 1, removedSentences: 0, checked: true }
  });
  assert.deepEqual(output.sourceStatus.chain?.map(stage => stage.id), ['rag', 'graph', 'ontology', 'okf', 'mcp', 'agent']);
  assert.match(output.markdown, /## 근거 형성 과정/);
  assert.match(output.markdown, /\*\*관계 그래프\*\* — 관련성 검토를 통과한 조문 1건에서 출발해 인용 관계 2건 발견 → 판례 원문으로 확인한 인용 1건 추가/);
  assert.match(output.markdown, /\*\*에이전트 판단·검증\*\* — 직접 조회 경로 → 관련성 필터 제외 1건 → 의미 검증 제외 0문장 → 답변 인용 2건/);
  assert.match(output.markdown, /경로: .*MCP search_laws.*OKF 카탈로그: Legal Corpus — Laws/);
  const precedentCitation = output.citations.find(citation => citation.citationId === linked.citationId);
  assert.ok(precedentCitation?.provenance?.some(route => route.startsWith('관계 그래프')), 'the citation carries its route for the UI');
  assert.ok(precedentCitation?.provenance?.some(route => route.includes('Legal Corpus — Precedents')));
});
