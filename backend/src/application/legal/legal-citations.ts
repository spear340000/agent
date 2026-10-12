import type { LegalSource } from '../../domain/legal-source.js';
import { articleDisplay, articleRefs, coversArticle, sourceArticleRefs, sourceIdentityRefs } from './legal-article-refs.js';

export const LEGAL_CITATION_PATTERN = /\[([LPGDWT]\d{1,3})\]/g;
const BARE_CITATION_PATTERN = /(^|[^\[][^\w])([LPGDWT]\d{1,3})(?![\w\]])/g;
const CURRENTNESS_CLAIM =
  /(?:현재\s*기준|현재\s*적용|현재\s*시행|현행\s*법률|현행\s*기준|최신\s*판례|최신\s*법령|지금\s*기준|오늘\s*기준|유효\s*한\s*법률|아직\s*효력이\s*있)/g;

const MIXED_SCRIPT = /[぀-ヿ]|[가-힣][一-鿿]|[一-鿿][가-힣]/g;

export type LegalAnswerValidation = {
  invalidCitations: string[];
  unsupportedCurrentness: string[];
  /** Article numbers named in the answer that no retrieved record contains. */
  unretrievedArticles: string[];
  /** Sentences whose cited records do not contain the article they discuss. */
  mismatchedClaims: string[];
  /** Stray Japanese/Chinese characters fused into Korean text. */
  foreignScript: string[];
  citationCount: number;
  valid: boolean;
};

export function legalCitationIds(text: string): string[] {
  return [...new Set([...text.matchAll(LEGAL_CITATION_PATTERN)].map(match => match[1]!))];
}

export function findInvalidLegalCitations(text: string, validCitationIds: readonly string[]): string[] {
  const valid = new Set(validCitationIds);
  return legalCitationIds(text).filter(id => !valid.has(id));
}

export function hasLegalCitation(text: string): boolean {
  return new RegExp(LEGAL_CITATION_PATTERN.source).test(text);
}

// Models sometimes put a zero-width space inside a citation ("[<U+200B>L5]"), which no longer matches "[L5]".
const INVISIBLE_CHARACTERS = /[​-‍⁠﻿]/g;

// A stray Chinese or Japanese character glued to Korean text ("및后", "행정责") is a model slip; drop it rather than
// failing the whole answer. Kana is never Korean, so it goes wherever it is; Han characters only when next to Hangul.
const STRAY_FOREIGN_CHARACTERS = /[぀-ヿ]+|(?<=[가-힣぀-ヿ])[一-鿿]+|[一-鿿]+(?=[가-힣぀-ヿ])/g;

/**
 * A retrieved decision named by its case number but without its [P#] id escapes both the citation list and the claim
 * check. Tie each such mention to the retrieved record so the sentence is verified against that judgment's text.
 */
export function attachCaseCitations(text: string, sources: readonly LegalSource[]): string {
  let result = text;
  for (const source of sources) {
    const caseNumber = source.caseNumber?.replace(/[\s,]+$/u, '');
    if (source.corpus !== 'precedent' || !caseNumber) continue;
    const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mention = new RegExp(`${escape(caseNumber)}(?!\\d)(?![^\\n\\[]{0,12}\\[${escape(source.citationId)}\\])`, 'gu');
    result = result.replace(mention, match => `${match} [${source.citationId}]`);
  }
  return result;
}

// A period such as "2년 이내" or "30일 전"; calendar dates ("5월 31일까지") are not periods.
const TIME_LIMIT = /(?<![년월]\s*)(?<!\d)\d{1,3}\s*(?:일|주|개월|년)\s*(?:이내|전|후|간)/gu;

/**
 * A deadline stated without any citation is the claim most likely to be invented and the most costly to get wrong
 * (a filing period). Drop such a sentence unless a retrieved record contains the same period.
 */
export function dropUnbackedTimeLimits(text: string, sources: readonly LegalSource[]): { text: string; removed: number } {
  const squash = (value: string): string => value.replace(/\s+/g, '');
  const corpus = squash(sources.map(source => `${source.title} ${source.excerpt}`).join(' '));
  const parts = splitAnswerParts(text);
  let removed = 0;
  const kept = parts.filter(part => {
    if (legalCitationIds(part.sentence).length > 0) return true;
    const periods = part.sentence.match(TIME_LIMIT) ?? [];
    const unbacked = periods.some(period => !corpus.includes(squash(period)));
    if (unbacked) removed += 1;
    return !unbacked;
  });
  return { text: removed > 0 ? joinAnswerParts(kept) : text, removed };
}

export function normalizeLegalCitations(rawText: string, validCitationIds: readonly string[]): string {
  const text = rawText.replace(INVISIBLE_CHARACTERS, '').replace(STRAY_FOREIGN_CHARACTERS, '');
  const valid = new Set(validCitationIds);
  if (valid.size === 0) return text;
  return text.replace(BARE_CITATION_PATTERN, (match, prefix: string, id: string) =>
    valid.has(id) ? `${prefix}[${id}]` : match
  );
}

// "최신 법령을 확인하세요" tells the reader to check; it does not assert that anything is current.
const CHECK_ADVICE_AFTER = /^[을를은는이가의에서도\s]{0,4}[^.\n]{0,20}?(?:확인|참조|참고|조회|검색|살펴|알아보|찾아)/u;

export function findUnsupportedCurrentnessClaims(text: string): string[] {
  const claims = [...text.matchAll(CURRENTNESS_CLAIM)]
    .filter(match => !CHECK_ADVICE_AFTER.test(text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 36)))
    .map(match => match[0]);
  return [...new Set(claims)];
}

function splitSentences(text: string): string[] {
  return text.split(/\n+|(?<=[.!?。])\s+/);
}

function citedSources(sentence: string, sources: readonly LegalSource[]): LegalSource[] {
  const byId = new Map(sources.map(source => [source.citationId, source]));
  return legalCitationIds(sentence).map(id => byId.get(id)).filter((item): item is LegalSource => Boolean(item));
}

/**
 * Articles named without being retrieved. An article counts as retrieved when a record is about it (and the same law,
 * when the sentence names one), or when the same sentence cites a record whose text quotes it; a mention inside some
 * unrelated retrieved record does not excuse it.
 */
export function findUnretrievedArticles(text: string, sources: readonly LegalSource[]): string[] {
  const identity = sources.flatMap(sourceIdentityRefs);
  const missing = new Map<string, string>();
  for (const sentence of splitSentences(text)) {
    const quoted = citedSources(sentence, sources).flatMap(sourceArticleRefs);
    for (const ref of articleRefs(sentence)) {
      if (!coversArticle(identity, ref) && !coversArticle(quoted, ref)) missing.set(`${ref.law ?? ''}|${ref.key}`, articleDisplay(ref));
    }
  }
  return [...missing.values()];
}

export function findMismatchedClaims(text: string, sources: readonly LegalSource[]): string[] {
  const mismatched: string[] = [];
  for (const sentence of splitSentences(text)) {
    const refs = articleRefs(sentence);
    const cited = citedSources(sentence, sources);
    if (refs.length === 0 || cited.length === 0) continue;
    const covered = cited.flatMap(sourceArticleRefs);
    if (refs.some(ref => !coversArticle(covered, ref))) mismatched.push(sentence.trim().slice(0, 80));
  }
  return mismatched;
}

export function findForeignScript(text: string): string[] {
  return [...new Set([...text.matchAll(MIXED_SCRIPT)].map(match => match[0]))];
}

export function validateLegalAnswer(input: {
  text: string;
  sources: readonly LegalSource[];
}): LegalAnswerValidation {
  const validCitationIds = input.sources.map(source => source.citationId);
  const invalidCitations = findInvalidLegalCitations(input.text, validCitationIds);
  const unsupportedCurrentness = findUnsupportedCurrentnessClaims(input.text);
  const unretrievedArticles = findUnretrievedArticles(input.text, input.sources);
  const mismatchedClaims = findMismatchedClaims(input.text, input.sources);
  const foreignScript = findForeignScript(input.text);
  return {
    invalidCitations,
    unsupportedCurrentness,
    unretrievedArticles,
    mismatchedClaims,
    foreignScript,
    citationCount: legalCitationIds(input.text).length,
    valid:
      invalidCitations.length === 0 &&
      unsupportedCurrentness.length === 0 &&
      unretrievedArticles.length === 0 &&
      mismatchedClaims.length === 0 &&
      foreignScript.length === 0
  };
}

function isUnsupportedSentence(sentence: string, sources: readonly LegalSource[]): boolean {
  const identity = sources.flatMap(sourceIdentityRefs);
  const cited = citedSources(sentence, sources);
  const covered = cited.flatMap(sourceArticleRefs);
  if (findUnsupportedCurrentnessClaims(sentence).length > 0) return true;
  return articleRefs(sentence).some(ref => (!coversArticle(identity, ref) && !coversArticle(covered, ref)) || (cited.length > 0 && !coversArticle(covered, ref)));
}

/** Removes sentences naming an article their citation does not support; returns how many were dropped. */
export function dropUnsupportedSentences(text: string, sources: readonly LegalSource[]): { text: string; removed: number } {
  const parts = text.split(/(\n+|(?<=[.!?。])\s+)/);
  let removed = 0;
  const kept: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const sentence = parts[index] ?? '';
    const separator = parts[index + 1] ?? '';
    if (sentence.trim() && isUnsupportedSentence(sentence, sources)) {
      removed += 1;
      continue;
    }
    kept.push(sentence, separator);
  }
  return { text: kept.join('').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

export type AnswerPart = { sentence: string; separator: string };

/** Splits an answer into sentences, keeping each one's trailing separator so the text can be rebuilt exactly. */
export function splitAnswerParts(text: string): AnswerPart[] {
  // A period after a digit belongs to a date or list number ("2022. 7. 21. 선고", "1. 항목"), not a sentence end.
  // A citation tag written after the period ("…판단했다. [P1]") belongs to the sentence before it, not to a sentence of its own.
  const pieces = text.split(/(\n+|(?<=[!?。]|(?<!\d)\.)\s+(?!\[[A-Z]\d+\]))/);
  const parts: AnswerPart[] = [];
  for (let index = 0; index < pieces.length; index += 2) parts.push({ sentence: pieces[index] ?? '', separator: pieces[index + 1] ?? '' });
  return parts;
}

export function joinAnswerParts(parts: readonly AnswerPart[]): string {
  return parts.map(part => `${part.sentence}${part.separator}`).join('').replace(/\n{3,}/g, '\n\n').trim();
}

export function citedSourcesOf(sentence: string, sources: readonly LegalSource[]): LegalSource[] {
  return citedSources(sentence, sources);
}
