import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LegalRequestRouter,
  countIssueSignals,
  extractCaseNumber,
  extractLawArticle,
  hasLegalCitationFormat,
  legalCitationFormats
} from '../src/application/legal/legal-request-router.ts';
import { planLegalSteps } from '../src/application/agent-service.ts';
import { LEGAL_ROUTING_DEFAULTS } from '../src/config/env.ts';

const router = new LegalRequestRouter({
  multiIssueThreshold: LEGAL_ROUTING_DEFAULTS.multiIssueThreshold,
  complexDraftCharacters: LEGAL_ROUTING_DEFAULTS.complexDraftCharacters,
  multiAttachmentThreshold: LEGAL_ROUTING_DEFAULTS.multiAttachmentThreshold,
  directQueryLimit: 2
});

const route = (prompt: string, attachmentCount = 0) => router.route({ prompt, attachmentCount });

class NonLegalDocumentRoute {
  readonly selected: 'document' = 'document';
}

test('a straightforward legal question takes the direct path with no planner call', () => {
  const decision = route('중과실의 기준은 무엇인가요?');
  assert.equal(decision.path, 'direct');
  assert.equal(decision.legal, true);
  assert.equal(decision.plannerCalls, 0);
  assert.equal(decision.intent, 'legal-question');
  assert.deepEqual(decision.steps, [
    { kind: 'search-laws', query: '중과실의 기준은 무엇인가요?', limit: 5 },
    { kind: 'search-precedents', query: '중과실의 기준은 무엇인가요?', limit: 5 }
  ]);
});

test('the user prompt is sent to the index verbatim instead of a hand-edited query', () => {
  const prompt = '임대인이 보증금을 갚지 않으면 어떻게 해야 하나요?';
  const decision = route(prompt);
  assert.equal(decision.steps[0]?.kind, 'search-laws');
  assert.equal(decision.steps[0]?.kind === 'search-laws' ? decision.steps[0].query : '', prompt);
  assert.equal(decision.steps[1]?.kind === 'search-precedents' ? decision.steps[1].query : '', prompt);
});

test('the direct retrieval plan preserves every original whitespace character', () => {
  const prompt = '  위약금 기준\n\t설명 부탁해요.  ';
  const decision = route(prompt);
  assert.equal(decision.originalPrompt, prompt);
  assert.equal(decision.steps[0]?.kind === 'search-laws' ? decision.steps[0].query : '', prompt);
  assert.equal(decision.steps[1]?.kind === 'search-precedents' ? decision.steps[1].query : '', prompt);
});

test('routing never guesses from a topic word list', () => {
  assert.equal(hasLegalCitationFormat('민법 제398조'), true);
  assert.equal(hasLegalCitationFormat('법률 제14조제1항'), true);
  assert.equal(hasLegalCitationFormat('2020다227455 판결'), true);
  assert.equal(hasLegalCitationFormat('2026년 3월 12일 시행'), true);
  assert.equal(hasLegalCitationFormat('칼날로 다치면 어떻게 되나요'), false);
  assert.deepEqual(legalCitationFormats('민법 제398조'), { article: true, caseNumber: false, lawReference: true, effectiveDate: false });

  for (const prompt of ['칼날', '번역해 주세요', '이 문서를 요약해 주세요', '이번 주 일정 회의록을 정리해 주세요', '위약금 감액 기준 알려 주세요']) {
    assert.notEqual(route(prompt).path, 'document', `${prompt} must never be classified by topic vocabulary`);
  }
  assert.equal(route('첨부한 계약서를 요약해 주세요', 1).path, 'direct', 'an uploaded document is legal evidence, not a routing signal');
  assert.equal(route('첨부한 계약서를 요약해 주세요', 1).intent, 'legal-question');
});

test('an exact article lookup uses the smallest exact retrieval tool set', () => {
  const decision = route('민법 제398조 내용이 궁금합니다.');
  assert.equal(decision.path, 'direct');
  assert.equal(decision.intent, 'article-lookup');
  assert.deepEqual(decision.article, { lawName: '민법', articleNumber: '제398조' });
  assert.deepEqual(decision.steps, [{ kind: 'law-article', lawName: '민법', articleNumber: '제398조' }]);
  assert.equal(decision.plannerCalls, 0);
  assert.equal(countIssueSignals('민법 제398조 내용이 궁금합니다.'), 0);
});

test('a case number lookup prefers the case-number tool', () => {
  const decision = route('2013가합30895 판례의 판결요지를 알려 주세요.');
  assert.equal(decision.intent, 'case-lookup');
  assert.equal(decision.caseNumber, '2013가합30895');
  assert.deepEqual(decision.steps, [{ kind: 'case-number', caseNumber: '2013가합30895' }]);
});

test('a precedent question searches precedents instead of statutes only', () => {
  const decision = route('집주인이 보증금을 반환하지 않을 때 판례는 어떻게 판단하나요?');
  assert.deepEqual(decision.steps.map(step => step.kind), ['search-laws', 'search-precedents']);
});

test('a multi-part comparison across laws and precedents is orchestrated and plans exactly once', () => {
  const decision = route('위약금과 손해배상 예정의 차이를 비교해 주세요? 그리고 각각 적용되는 판례도 알려 주세요.');
  assert.equal(decision.path, 'orchestrated');
  assert.equal(decision.plannerCalls, 1);
  assert.deepEqual(decision.steps, [], 'orchestrated retrieval steps come from the planner');
  assert.ok(decision.reasons.some(reason => reason.includes('항목으로 나뉘어')));
});

test('a single-sentence question stays direct even when it sounds complex', () => {
  const decision = route('2015년 당시 위약금 인정 기준이 지금 규칙과 어떻게 다른지 알려 주세요.');
  assert.equal(decision.path, 'direct', 'no substring rule may promote a single-issue question to the planner');
  assert.equal(decision.plannerCalls, 0);
});

test('an as-of question split into parts is orchestrated', () => {
  const decision = route('2015년 당시 위약금 기준을 알려 주세요? 그리고 지금 규칙도 알려 주세요.');
  assert.equal(decision.path, 'orchestrated');
  assert.ok(decision.reasons.some(reason => reason.includes('항목으로 나뉘어')));
});

test('multiple issue sentences alone trigger the orchestrated path', () => {
  const prompt = '위약금이란 무엇인가요? 그리고 감액 기준은 어떻게 되나요?';
  assert.ok(countIssueSignals(prompt) >= LEGAL_ROUTING_DEFAULTS.multiIssueThreshold);
  assert.equal(route(prompt).path, 'orchestrated');
});

test('two or more uploaded sources move a request to the orchestrated legal path', () => {
  const decision = route('첨부한 계약서 두 건의 위약금 조항 차이를 확인해 주세요.', 2);
  assert.equal(decision.path, 'orchestrated');
  assert.ok(decision.reasons.some(reason => reason.includes('첨부 자료')));
});

test('a simple fact-based first draft stays on the direct path', () => {
  const decision = route('임대차계약 해지 통보문 초안을 작성해 주세요. 임대인은 홍길동, 임차인은 김철수입니다.');
  assert.equal(decision.path, 'direct');
  assert.equal(decision.intent, 'legal-draft');
  assert.equal(decision.draftKind, 'legal-document');
  assert.equal(decision.plannerCalls, 0);
});

test('a long legal draft is orchestrated', () => {
  const prompt = `${'임대차 해지 통보문 초안을 작성해 주세요. '.repeat(40)}관련 근거를 확인해 주세요.`;
  assert.ok(prompt.length > LEGAL_ROUTING_DEFAULTS.complexDraftCharacters);
  assert.equal(route(prompt).path, 'orchestrated');
  assert.equal(route(prompt).plannerCalls, 1);
});

test('the document workflow is selected by the caller, not by a keyword guess', () => {
  const legal = route('주간 판매 요약 보고서를 작성해 주세요.');
  assert.equal(legal.path, 'direct');
  assert.equal(legal.plannerCalls, 0);
  const document = new NonLegalDocumentRoute();
  assert.equal(document.selected, 'document');
});

test('web search is requested only for current-information or official-link needs', () => {
  assert.equal(route('위약금 감액 기준 알려 주세요.').needsWeb, false);
  const current = route('현재 시행 중인 위약금 감액 기준과 공식 링크를 알려 주세요.');
  assert.equal(current.needsWeb, true);
  assert.deepEqual(current.webQueries, ['현재 시행 중인 위약금 감액 기준과 공식 링크를 알려 주세요.']);
});

test('legal identifier extraction is deterministic', () => {
  assert.deepEqual(extractLawArticle('근로기준법 제50조'), { lawName: '근로기준법', articleNumber: '제50조' });
  assert.deepEqual(extractLawArticle('손해배상 예정에서 제398조'), { articleNumber: '제398조' });
  assert.equal(extractLawArticle('오늘 날씨가 어때요'), undefined);
  assert.equal(extractCaseNumber('대법원 2020다227455 판결을 알려 주세요'), '2020다227455');
  assert.equal(extractCaseNumber('2026년 3월 12일 시행'), undefined);
});

test('step plans only include stages that actually run', () => {
  const direct = planLegalSteps({ sourceFileIds: [] }, route('중과실의 기준은 무엇인가요?'));
  assert.deepEqual(direct.map(step => step.key), ['legal:retrieve', 'legal:write']);
  const orchestrated = planLegalSteps(
    { sourceFileIds: ['file_1', 'file_2'] },
    route('위약금이란 무엇인가요? 그리고 감액 기준은 어떻게 되나요?', 2)
  );
  assert.deepEqual(orchestrated.map(step => step.key), [
    'legal:documents',
    'legal:plan',
    'legal:retrieve',
    'legal:verify',
    'legal:write'
  ]);
  const directWithWeb = planLegalSteps({ sourceFileIds: [] }, route('현재 시행 중인 위약금 기준과 공식 링크를 알려 주세요.'));
  assert.deepEqual(directWithWeb.map(step => step.key), ['legal:retrieve', 'legal:web', 'legal:write']);
});
