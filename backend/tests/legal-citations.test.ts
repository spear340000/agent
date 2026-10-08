import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findInvalidLegalCitations,
  findUnsupportedCurrentnessClaims,
  hasLegalCitation,
  legalCitationIds,
  dropUnsupportedSentences,
  normalizeLegalCitations,
  attachCaseCitations,
  validateLegalAnswer
} from '../src/application/legal/legal-citations.ts';
import type { LegalSource } from '../src/domain/legal-source.ts';

const source = (overrides: Partial<LegalSource> & Pick<LegalSource, 'citationId'>): LegalSource => ({
  kind: 'law-article',
  corpus: 'law',
  recordId: 'law:test',
  title: '민법 제398조',
  excerpt: 'test',
  ...overrides
});

const law = source({ citationId: 'L1', lawName: '민법', articleNumber: '제398조' });
const precedent = source({ citationId: 'P1', kind: 'precedent', corpus: 'precedent', recordId: 'case:1', caseNumber: '2013가합30895', date: { kind: 'decision', value: '2015-07-03' } });
const upload = source({ citationId: 'D1', kind: 'document', corpus: 'document', recordId: 'TXT1:a.txt', title: 'a.txt' });
const web = source({ citationId: 'W1', kind: 'web', corpus: 'web', recordId: 'https://example.com', title: 'page' });

test('citation handles are collected and deduplicated', () => {
  assert.deepEqual(legalCitationIds('제398조 [L1]와 판례 [P1]를 함께 보면 [L1]입니다.').sort(), ['L1', 'P1']);
  assert.equal(hasLegalCitation('근거 [L2]'), true);
  assert.equal(hasLegalCitation('근거 없음'), false);
});

test('citations outside the returned records are rejected', () => {
  assert.deepEqual(findInvalidLegalCitations('[L1] [L9] [P2]', ['L1', 'P1']), ['L9', 'P2']);
  assert.deepEqual(findInvalidLegalCitations('[L1] [D1] [W1]', ['L1', 'D1', 'W1']), []);
});

test('bare citation handles are normalized into bracketed citations', () => {
  assert.equal(normalizeLegalCitations('민법 조항 L1에 따르면 그렇습니다.', ['L1', 'P1']), '민법 조항 [L1]에 따르면 그렇습니다.');
  assert.equal(normalizeLegalCitations('판례 P1도 확인했습니다.', ['L1', 'P1']), '판례 [P1]도 확인했습니다.');
  assert.equal(normalizeLegalCitations('이미 [L1] 형식입니다.', ['L1']), '이미 [L1] 형식입니다.');
  assert.equal(normalizeLegalCitations('존재하지 않는 L9는 그대로 둡니다.', ['L1']), '존재하지 않는 L9는 그대로 둡니다.', 'an unknown id is never promoted to a real citation');
  assert.equal(normalizeLegalCitations('L1 은 약자로도 쓰입니다.', []), 'L1 은 약자로도 쓰입니다.');
});

test('an answer is accepted when every citation maps to a returned record', () => {
  const validation = validateLegalAnswer({
    text: '「해석」법원의 판단은 손해액을 예정할 수 있습니다 [L1]. 유사 판례도 있습니다 [P1].',
    sources: [law, precedent]
  });
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.invalidCitations, []);
  assert.deepEqual(validation.unsupportedCurrentness, []);
  assert.equal(validation.citationCount, 2);
});

test('an honest answer with no inline citation is publishable and counted', () => {
  const validation = validateLegalAnswer({ text: '확인된 기록이 없어 판단을 유보합니다.', sources: [law] });
  assert.equal(validation.valid, true);
  assert.equal(validation.citationCount, 0);
});

test('uploaded documents and web pages are citable like legal records', () => {
  const validation = validateLegalAnswer({ text: '첨부 계약서 [D1]와 공식 안내 [W1]을 확인하세요.', sources: [law, upload, web] });
  assert.equal(validation.valid, true);
  assert.equal(validation.citationCount, 2);
});

test('currentness claims are rejected when no record carries a date', () => {
  const undated = [source({ citationId: 'L1' })];
  const claims = findUnsupportedCurrentnessClaims('현재 시행 중인 조항입니다 [L1].', undated);
  assert.deepEqual(claims, ['현재 시행']);
  assert.equal(validateLegalAnswer({ text: '현재 시행 중인 조항입니다 [L1].', sources: undated }).valid, false);
});

test('an amendment date can be cited as a date without making currentness claims', () => {
  const dated = [source({ citationId: 'L1', date: { kind: 'amendment', value: '2010.1.22' } })];
  assert.deepEqual(findUnsupportedCurrentnessClaims('개정 표기가 있는 조항입니다 [L1].'), []);
  assert.equal(validateLegalAnswer({ text: '개정 표기 2010.1.22 조항입니다 [L1].', sources: dated }).valid, true);
});

test('an amendment date alone does not establish that a law is currently in force', () => {
  const dated = [source({ citationId: 'L1', date: { kind: 'amendment', value: '2010.1.22' } })];
  const claims = findUnsupportedCurrentnessClaims('현재 시행 중인 조항입니다 [L1].');
  assert.deepEqual(claims, ['현재 시행']);
});

test('a no-evidence answer may omit citations but not invent them', () => {
  assert.equal(validateLegalAnswer({ text: '해당 기록을 찾지 못했습니다.', sources: [] }).valid, true);
  const invented = validateLegalAnswer({ text: '확인된 조항은 [L1]입니다.', sources: [] });
  assert.equal(invented.valid, false);
  assert.deepEqual(invented.invalidCitations, ['L1']);
});

test('generic document citation markers are not accepted as legal citations', () => {
  const validation = validateLegalAnswer({ text: '근거 [PDF1]', sources: [law] });
  assert.equal(validation.valid, true);
  assert.equal(validation.citationCount, 0);
});

test('claims about articles that were not retrieved or not cited are rejected', () => {
  const sources = [law, source({ citationId: 'L2', lawName: '개인정보 보호법', articleNumber: '제75조', title: '개인정보 보호법 제75조' })];
  const unretrieved = validateLegalAnswer({ text: '제71조에 따라 형사처벌됩니다 [L2].', sources });
  assert.deepEqual(unretrieved.unretrievedArticles, ['제71조']);
  assert.equal(unretrieved.valid, false);
  const mismatch = validateLegalAnswer({ text: '제398조의 요건을 갖추면 책임이 있습니다 [L2].', sources });
  assert.equal(mismatch.mismatchedClaims.length, 1);
  assert.equal(mismatch.valid, false);
  assert.equal(validateLegalAnswer({ text: '제398조는 손해배상액의 예정을 정합니다 [L1].', sources }).valid, true);
});

test('Japanese or Chinese characters fused into Korean text are flagged', () => {
  assert.deepEqual(validateLegalAnswer({ text: '행정责 및 형사责이 있습니다.', sources: [law] }).foreignScript.sort(), ['정责', '사责'].sort());
  assert.equal(validateLegalAnswer({ text: '行われた 사실입니다.', sources: [law] }).valid, false);
  assert.equal(validateLegalAnswer({ text: '민법(民法) 제398조 [L1]', sources: [law] }).valid, true);
});

test('an uncited aside about an article that only appears inside another record is rejected', () => {
  const base = source({ citationId: 'L1', lawName: '민법', articleNumber: '제398조', title: '민법 제398조', excerpt: '법원은 적당히 감액할 수 있다. 제765조 참조' });
  const other = source({ citationId: 'P1', kind: 'precedent', corpus: 'precedent', recordId: 'case:9', title: '손해배상 사건', excerpt: '제765조에 따른 경감' });
  const aside = validateLegalAnswer({ text: '제398조는 감액을 허용합니다 [L1].\n(참고: 민법 제765조는 경감청구를 다룹니다.)', sources: [base, other] });
  assert.deepEqual(aside.unretrievedArticles, ['민법 제765조']);
  assert.equal(aside.valid, false);
  const cited = validateLegalAnswer({ text: '제398조는 감액을 허용하며 제765조도 참조됩니다 [L1].', sources: [base, other] });
  assert.deepEqual(cited.unretrievedArticles, [], 'the cited record itself quotes 제765조');
  assert.equal(cited.valid, true);
});

test('unsupported sentences are dropped while supported ones and their line breaks survive', () => {
  const base = source({ citationId: 'L1', lawName: '민법', articleNumber: '제398조', title: '민법 제398조', excerpt: '법원은 감액할 수 있다.' });
  const answer = '제398조는 감액을 허용합니다 [L1].\n(참고: 민법 제765조는 경감청구를 다룹니다.)\n따라서 법원이 조정할 수 있습니다 [L1].';
  const pruned = dropUnsupportedSentences(answer, [base]);
  assert.equal(pruned.removed, 1);
  assert.equal(pruned.text, '제398조는 감액을 허용합니다 [L1].\n따라서 법원이 조정할 수 있습니다 [L1].');
  assert.equal(validateLegalAnswer({ text: pruned.text, sources: [base] }).valid, true);
  assert.equal(dropUnsupportedSentences('근거 없는 내용입니다.', [base]).removed, 0);
});

test('the same article number in a different law is not accepted as support', () => {
  const civil = source({ citationId: 'L1', lawName: '민법', articleNumber: '제750조', title: '민법 제750조', excerpt: '고의 또는 과실로 타인에게 손해를 가한 자' });
  const privacy = source({ citationId: 'L2', lawName: '개인정보 보호법', articleNumber: '제34조', title: '개인정보 보호법 제34조', excerpt: '유출 통지' });
  assert.deepEqual(validateLegalAnswer({ text: '형법 제750조는 처벌을 정합니다.', sources: [civil, privacy] }).unretrievedArticles, ['형법 제750조']);
  assert.equal(validateLegalAnswer({ text: '민법 제750조는 불법행위 책임을 정합니다 [L1].', sources: [civil, privacy] }).valid, true);
  assert.equal(validateLegalAnswer({ text: '개인정보 보호법 제34조는 유출 통지를 정합니다 [L2].', sources: [civil, privacy] }).valid, true, 'spacing in the law name does not matter');
  assert.equal(validateLegalAnswer({ text: '제750조에 따라 책임이 있습니다 [L1].', sources: [civil, privacy] }).valid, true, 'an unnamed law is not second-guessed');
  assert.equal(validateLegalAnswer({ text: '「민법」 제750조 및 같은 법 제750조 [L1].', sources: [civil, privacy] }).valid, true, 'closing quotes and "같은 법" are handled');
  assert.equal(validateLegalAnswer({ text: '민법 제34조는 유출 통지를 정합니다 [L2].', sources: [civil, privacy] }).valid, false, 'a real article number under the wrong law');
});

test('advice to check the latest law is not a currentness claim, but asserting it is', () => {
  assert.deepEqual(findUnsupportedCurrentnessClaims('최신 법령을 국가법령정보센터에서 확인하세요.'), []);
  assert.deepEqual(findUnsupportedCurrentnessClaims('현행 기준은 반드시 확인해 보시기 바랍니다.'), []);
  assert.deepEqual(findUnsupportedCurrentnessClaims('이 조항이 최신 법령입니다.'), ['최신 법령']);
  assert.deepEqual(findUnsupportedCurrentnessClaims('현재 시행 중인 조항입니다.'), ['현재 시행']);
});

test('a sentence asserting currentness is dropped instead of failing the whole answer', () => {
  const base = source({ citationId: 'L1', lawName: '민법', articleNumber: '제398조', title: '민법 제398조', excerpt: '감액할 수 있다.' });
  const pruned = dropUnsupportedSentences('제398조는 감액을 허용합니다 [L1].\n이 조항이 최신 법령입니다.\n최신 법령은 직접 확인하세요.', [base]);
  assert.equal(pruned.removed, 1);
  assert.equal(pruned.text, '제398조는 감액을 허용합니다 [L1].\n최신 법령은 직접 확인하세요.');
});

import { matchWikiHints, parseWikiCore } from '../src/application/legal/legal-wiki-hints.ts';

const LABOR_PAGE = `---\r\ntype: Document\r\ntitle: labor-law-core\r\n---\r\n\r\n---\r\ntype: Law\r\ntitle: 근로기준법 핵심 조문 검색집\r\nsources:\r\n  - https://www.law.go.kr/법령/근로기준법\r\nstatus: active\r\ntags: [근로계약, 임금, 해고, 직장내괴롭힘]\r\n---\r\n# 근로기준법 핵심 조문 검색집\r\n\r\n- 제23조 해고 등의 제한: 정당한 이유 없이 해고, 휴직, 정직을 하지 못한다.\r\n- 제26조 해고의 예고: 해고하려면 30일 전에 예고하여야 한다.\r\n- 제43조 임금 지급: 임금은 통화로 직접 근로자에게 전액을 지급하여야 한다.\r\n- 제23조 해고 등의 제한: 정당한 이유 없이 해고, 휴직, 정직을 하지 못한다.\r\n`;

test('a wiki key-article page yields its law, official URL, tags and articles', () => {
  const hints = parseWikiCore(LABOR_PAGE);
  assert.equal(hints.length, 4);
  assert.deepEqual([hints[0]!.lawName, hints[0]!.article, hints[0]!.title, hints[0]!.sourceUrl], ['근로기준법', '제23조', '해고 등의 제한', 'https://www.law.go.kr/법령/근로기준법']);
  assert.deepEqual(hints[0]!.tags, ['근로계약', '임금', '해고', '직장내괴롭힘']);
  assert.deepEqual(parseWikiCore('# 일반 문서\n- 제1조 무관: 내용'), [], 'only key-article pages are read');
});

test('hints are chosen by tag and title overlap, deduplicated, and absent for unrelated questions', () => {
  const hints = parseWikiCore(LABOR_PAGE);
  const matches = matchWikiHints('회사에서 갑자기 해고당했어요. 어떻게 해야 하나요?', hints, 3);
  assert.equal(matches[0]!.article, '제23조');
  assert.equal(new Set(matches.map(match => match.article)).size, matches.length, 'the duplicated entry appears once');
  assert.deepEqual(matchWikiHints('오늘 점심 뭐 먹지', hints, 3), []);
  assert.deepEqual(matchWikiHints('', hints, 3), []);
});

test('invisible characters inside a citation do not hide it', () => {
  const zeroWidth = '​';
  const text = `의무가 있습니다 [${zeroWidth}L5]. 원칙입니다 [L${zeroWidth}4][${zeroWidth}L5].`;
  const fixed = normalizeLegalCitations(text, ['L4', 'L5']);
  assert.equal(fixed, '의무가 있습니다 [L5]. 원칙입니다 [L4][L5].');
  assert.deepEqual(legalCitationIds(fixed).sort(), ['L4', 'L5']);
  assert.equal(normalizeLegalCitations(`a${zeroWidth}b`, []), 'ab', 'cleaned even when there are no sources');
});

test('stray Chinese or Japanese characters fused to Korean are removed instead of failing the answer', () => {
  assert.equal(normalizeLegalCitations('가해자 및后 처벌과 행정责 [L1]', ['L1']), '가해자 및 처벌과 행정 [L1]');
  assert.equal(normalizeLegalCitations('사실입니다 行われた 끝', ['L1']), '사실입니다  끝');
  assert.equal(normalizeLegalCitations('민법(民法) 제398조 [L1]', ['L1']), '민법(民法) 제398조 [L1]', 'a parenthesised Han term is kept');
  const cleaned = normalizeLegalCitations('형사责이 있습니다 [L1]', ['L1']);
  assert.deepEqual(validateLegalAnswer({ text: cleaned, sources: [source({ citationId: 'L1' })] }).foreignScript, []);
});

test('a retrieved decision named by case number is tied to its record id exactly once', () => {
  const sources = [source({ citationId: 'P1', corpus: 'precedent', kind: 'precedent', caseNumber: '2018다248855,' } as never)];
  const text = '대법원 2018다248855 판결은 위약벌을 다룹니다. 또 2018다248855 [P1] 은 이미 인용됐습니다. 2018다2488551은 다른 사건입니다.';
  const tied = attachCaseCitations(text, sources);
  assert.equal(tied, '대법원 2018다248855 [P1] 판결은 위약벌을 다룹니다. 또 2018다248855 [P1] 은 이미 인용됐습니다. 2018다2488551은 다른 사건입니다.');
  assert.equal(attachCaseCitations(tied, sources), tied, 'applying it again changes nothing');
  assert.equal(attachCaseCitations('2018다248855', [source({ citationId: 'L1' })]), '2018다248855', 'only precedent records are matched');
});
