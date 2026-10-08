import assert from 'node:assert/strict';
import test from 'node:test';
import { containment, fitEvidenceToBudget } from '../src/application/legal/legal-evidence-budget.ts';
import type { LegalSource } from '../src/domain/legal-source.ts';

const source = (id: number, relevance?: number): LegalSource => ({
  citationId: `L${id}`, kind: 'law-article', corpus: 'law', recordId: `law:${id}`, title: `법 제${id}조`, excerpt: '가'.repeat(5_000),
  ...(relevance === undefined ? {} : { relevance })
});

test('evidence is ranked by relevance, kept in original order, and shares the budget evenly', () => {
  const sources = [source(1, 0.2), source(2, 0.9), source(3), source(4, 0.5), source(5, 0.1), source(6, 0.95), source(7, 0.3)];
  const fitted = fitEvidenceToBudget(sources, 2_000);
  assert.deepEqual(fitted.map(item => item.source.citationId), ['L2', 'L3', 'L6'], 'the three best (an unscored exact lookup counts as 1), in retrieval order');
  assert.ok(fitted.every(item => item.excerptLimit >= 400 && item.excerptLimit <= 4_000));
  assert.equal(fitEvidenceToBudget(sources, 100_000).length, 7, 'a large budget keeps everything');
  assert.deepEqual(fitEvidenceToBudget([], 1_000), []);
  assert.equal(fitEvidenceToBudget(sources, 10).length, 1, 'at least one record always remains');
});

test('the prompt text actually fits the budget', () => {
  const sources = Array.from({ length: 30 }, (_, index) => source(index + 1, 1 - index / 100));
  const fitted = fitEvidenceToBudget(sources, 6_000);
  const used = fitted.reduce((sum, item) => sum + Math.min(item.source.excerpt.length, item.excerptLimit) + 250, 0);
  assert.ok(used <= 6_000 + 250, `used ${used}`);
});

import { relevantExcerpt, searchWords } from '../src/application/legal/legal-evidence-budget.ts';

test('a long text is cut around the part that discusses the question, not just from its first line', () => {
  const filler = '일반적인 절차에 관한 설명이 이어집니다. ';
  const key = '손해배상의 예정액이 부당히 과다한 경우에는 법원이 감액할 수 있습니다. ';
  const text = filler.repeat(40) + key + filler.repeat(40);
  const excerpt = relevantExcerpt(text, ['손해배상 예정액 감액'], 200);
  assert.ok(excerpt.includes('부당히 과다한'), 'the matching stretch is inside the window');
  assert.ok(excerpt.startsWith('…') && excerpt.endsWith('…'));
  assert.equal(relevantExcerpt('짧은 글', ['짧은'], 200), '짧은 글', 'text that fits is returned whole');
  assert.equal(relevantExcerpt(text, ['zzzqq'], 100), text.slice(0, 100), 'with no overlap the start is kept');
  assert.equal(relevantExcerpt(text, [], 100), text.slice(0, 100));
});

test('Korean particles do not stop a word from matching', () => {
  assert.deepEqual(searchWords('책임을, 지나요?'), ['책임을', '지나요']);
  const text = `${'가나다라마바사 '.repeat(60)}회사의 책임은 다음과 같다. ${'가나다라마바사 '.repeat(60)}`;
  assert.ok(relevantExcerpt(text, ['회사가 책임을'], 80).includes('책임은'));
});

test('containment is 1 for a quotation and low for an unrelated claim', () => {
  const article = '고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다.';
  assert.equal(containment('고의 또는 과실로 인한 위법행위로 타인에게 손해를 가한 자는 그 손해를 배상할 책임이 있다. [L1]', article), 1);
  assert.ok(containment('위약벌은 법원이 마음대로 감액할 수 있습니다.', article) < 0.5);
  assert.equal(containment('', article), 0);
});
