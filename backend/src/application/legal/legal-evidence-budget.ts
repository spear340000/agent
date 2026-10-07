import type { LegalSource } from '../../domain/legal-source.js';

export type BudgetedSource = { source: LegalSource; excerptLimit: number };

const FIXED_COST_PER_SOURCE = 250;
const MIN_EXCERPT = 400;
const MAX_EXCERPT = 4_000;

/**
 * Chooses which retrieved records go into a model prompt and how much of each text to include, so the prompt fits a
 * character budget. Records are ranked by relevance (an exact article lookup has no score and counts as 1) and the
 * remaining space is shared evenly; records that no longer fit are left out and simply cannot be cited.
 */
export function fitEvidenceToBudget(sources: readonly LegalSource[], budgetChars: number): BudgetedSource[] {
  if (sources.length === 0) return [];
  const ranked = sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => (b.source.relevance ?? 1) - (a.source.relevance ?? 1) || a.index - b.index);
  const fits = Math.max(1, Math.floor(budgetChars / (FIXED_COST_PER_SOURCE + MIN_EXCERPT)));
  const chosen = ranked.slice(0, fits);
  const excerptLimit = Math.min(MAX_EXCERPT, Math.max(MIN_EXCERPT, Math.floor(budgetChars / chosen.length) - FIXED_COST_PER_SOURCE));
  return chosen
    .sort((a, b) => a.index - b.index)
    .map(({ source }) => ({ source, excerptLimit }));
}

/** Hangul/letter/digit words of at least two characters; punctuation and spacing split words. */
export function searchWords(text: string): string[] {
  return (text.match(/[가-힣A-Za-z0-9]{2,}/gu) ?? []);
}

function bigramSet(terms: readonly string[]): Set<string> {
  const grams = new Set<string>();
  for (const word of terms.flatMap(searchWords)) for (let index = 0; index + 2 <= word.length; index += 1) grams.add(word.slice(index, index + 2));
  return grams;
}

/**
 * Cuts `text` to `limit` characters around the stretch that shares the most character pairs with `terms`, so a long
 * article or judgment is shown where it talks about the question rather than just from its first line. Text that
 * already fits is returned whole; with no overlap the start is kept.
 */
export function relevantExcerpt(text: string, terms: readonly string[], limit: number): string {
  if (text.length <= limit) return text;
  const grams = bigramSet(terms);
  if (grams.size === 0) return text.slice(0, limit);
  const prefix = new Array<number>(text.length + 1).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    prefix[index + 1] = prefix[index]! + (index + 2 <= text.length && grams.has(text.slice(index, index + 2)) ? 1 : 0);
  }
  let firstBest = 0;
  let lastBest = 0;
  let bestScore = -1;
  for (let start = 0; start + limit <= text.length; start += 1) {
    // Only pairs that lie fully inside the window count; the pair starting on its last character would spill out.
    const score = prefix[start + limit - 1]! - prefix[start]!;
    if (score > bestScore) { bestScore = score; firstBest = start; lastBest = start; }
    else if (score === bestScore) lastBest = start;
  }
  if (bestScore <= 0) return text.slice(0, limit);
  // Equally good windows form a run; the middle one keeps context on both sides of the match.
  const bestStart = Math.floor((firstBest + lastBest) / 2);
  const body = text.slice(bestStart, bestStart + limit);
  return `${bestStart > 0 ? '…' : ''}${body}${bestStart + limit < text.length ? '…' : ''}`;
}
