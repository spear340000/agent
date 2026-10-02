import type { LegalSource } from '../../domain/legal-source.js';

export const LEGAL_CITATION_PATTERN = /\[([LPGDWT]\d{1,3})\]/g;
const BARE_CITATION_PATTERN = /(^|[^\[][^\w])([LPGDWT]\d{1,3})(?![\w\]])/g;
const CURRENTNESS_CLAIM =
  /(?:현재\s*기준|현재\s*적용|현재\s*시행|현행\s*법률|현행\s*기준|최신\s*판례|최신\s*법령|지금\s*기준|오늘\s*기준|유효\s*한\s*법률|아직\s*효력이\s*있)/g;

export type LegalAnswerValidation = {
  invalidCitations: string[];
  unsupportedCurrentness: string[];
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

export function normalizeLegalCitations(text: string, validCitationIds: readonly string[]): string {
  const valid = new Set(validCitationIds);
  if (valid.size === 0) return text;
  return text.replace(BARE_CITATION_PATTERN, (match, prefix: string, id: string) =>
    valid.has(id) ? `${prefix}[${id}]` : match
  );
}

export function findUnsupportedCurrentnessClaims(text: string, sources: readonly LegalSource[]): string[] {
  const claims = [...new Set([...text.matchAll(CURRENTNESS_CLAIM)].map(match => match[0]))];
  if (claims.length === 0) return [];
  return sources.some(source => Boolean(source.date)) ? [] : claims;
}

export function validateLegalAnswer(input: {
  text: string;
  sources: readonly LegalSource[];
}): LegalAnswerValidation {
  const validCitationIds = input.sources.map(source => source.citationId);
  const invalidCitations = findInvalidLegalCitations(input.text, validCitationIds);
  const unsupportedCurrentness = findUnsupportedCurrentnessClaims(input.text, input.sources);
  return {
    invalidCitations,
    unsupportedCurrentness,
    citationCount: legalCitationIds(input.text).length,
    valid: invalidCitations.length === 0 && unsupportedCurrentness.length === 0
  };
}
