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
  browser?: { searchMany: (queries: string[], limit: number) => Promise<never[]>; visitMany: (urls: string[]) => Promise<never[]> };
}) {
  const router = new LegalRequestRouter({ multiIssueThreshold: 2, complexDraftCharacters: 700, multiAttachmentThreshold: 2, directQueryLimit: 2 });
  const workflow = new LegalWorkflow({
    retrieval: input.retrieval,
    model: input.model,
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

test('a currentness claim without a dated record is rejected', async () => {
  await withWorkspace(async ({ tasks, files }) => {
    const undated: LegalSource = { ...lawSource, date: undefined, statusMarkers: undefined };
    let answers = 0;
    const model: ModelProvider = {
      complete: async () => {
        answers += 1;
        return '현재 시행 중인 조항입니다 [L1].';
      }
    };
    const stub = stubRetrieval([undated]);
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
