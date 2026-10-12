import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { LegalWikiHints } from '../src/application/legal/legal-wiki-hints.ts';

const supplement = path.resolve('backend', 'legal', 'wiki-supplement');
const wiki = new LegalWikiHints([path.join(supplement, 'missing-folder-is-skipped'), supplement]);

const CASES: Array<{ question: string; law: string; article: string }> = [
  { question: '회사에서 갑자기 해고당했는데 부당해고 구제 신청은 어떻게 하나요?', law: '근로기준법', article: '제28조' },
  { question: '친구에게 빌려준 돈 500만원을 돌려받기 위한 내용증명 초안을 작성해주세요.', law: '민법', article: '제598조' },
  { question: '상속 1순위는 누구이고 상속포기는 언제까지 해야 하나요?', law: '민법', article: '제1019조' },
  { question: '개인정보가 유출되면 회사는 어떤 책임을 지나요?', law: '개인정보 보호법', article: '제34조' },
  { question: '임대차 계약 갱신요구권과 묵시적 갱신의 차이를 알려주세요.', law: '주택임대차보호법', article: '제6조의3' },
  { question: '월세를 2기 이상 연체하면 집주인이 계약을 해지할 수 있나요?', law: '민법', article: '제640조' }
];

for (const item of CASES) {
  test(`the key-article supplement points "${item.question.slice(0, 18)}…" to ${item.law} ${item.article}`, async () => {
    const matches = await wiki.find(item.question, 3);
    assert.ok(
      matches.some(match => match.lawName.replace(/\s+/g, '') === item.law.replace(/\s+/g, '') && match.article === item.article),
      `got ${matches.map(match => `${match.lawName} ${match.article}`).join(', ') || 'nothing'}`
    );
  });
}

test('an unrelated question gets no supplement hints', async () => {
  assert.deepEqual(await wiki.find('오늘 점심 뭐 먹지', 3), []);
});

test('an article whose own title matches the question outranks unrelated articles of a page with many matching tags', async () => {
  const dismissal = await wiki.find('회사에서 갑자기 해고당했는데 부당해고 구제 신청은 어떻게 하나요?', 5);
  const articles = dismissal.map(match => `${match.lawName.replace(/\s+/g, '')} ${match.article}`);
  assert.ok(articles.indexOf('근로기준법 제28조') >= 0);
  assert.ok(!articles.slice(0, 3).includes('근로기준법 제76조의3'), 'the harassment article does not push the dismissal rules out of the top three');
});

test('the supplement points a traffic-accident question to the civil liability article', async () => {
  const matches = await wiki.find('교통사고로 다쳤는데 합의금은 어떻게 산정하나요?', 3);
  assert.ok(matches.some(match => match.lawName === '민법' && match.article === '제750조'), matches.map(match => `${match.lawName} ${match.article}`).join(', '));
});
