import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findInvalidLegalCitations,
  findUnsupportedCurrentnessClaims,
  hasLegalCitation,
  legalCitationIds,
  normalizeLegalCitations,
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
