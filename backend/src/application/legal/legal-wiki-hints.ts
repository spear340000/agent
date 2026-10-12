import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { searchWords } from './legal-evidence-budget.js';

export type WikiHint = {
  lawName: string;
  /** For example "제23조" or "제39조의2". */
  article: string;
  title: string;
  text: string;
  tags: string[];
  /** Official page recorded in the wiki page's own metadata (the OKF-style `sources` field). */
  sourceUrl?: string;
};

export type WikiHintMatch = Pick<WikiHint, 'lawName' | 'article' | 'title' | 'sourceUrl'>;

const ENTRY = /^-\s*(제\d+조(?:의\d+)?)\s+([^:：]+?)\s*[:：]\s*(.+)$/u;
const CORE_PAGE = /핵심\s*조문/u;

/** Reads one "핵심 조문 검색집" page: its law (from the official source URL), tags, and one entry per article line. */
export function parseWikiCore(markdown: string): WikiHint[] {
  if (!CORE_PAGE.test(markdown)) return [];
  const sourceUrl = /^\s*-\s*(https?:\/\/\S+)/mu.exec(markdown)?.[1];
  const urlName = sourceUrl ? decodeURIComponent(sourceUrl.split('/').pop() ?? '') : '';
  const titleName = /^title:\s*(.+?)\s*핵심\s*조문/mu.exec(markdown)?.[1]?.trim() ?? '';
  // Some pages link to a query URL (lsInfoP.do?lsId=...) instead of a law-name path; the page title names the law then.
  const lawName = urlName && !/[.?=]/.test(urlName) ? urlName : titleName;
  if (!lawName) return [];
  const tags = (/^tags:\s*\[(.*?)\]/mu.exec(markdown)?.[1] ?? '').split(',').map(tag => tag.trim()).filter(Boolean);
  const hints: WikiHint[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = ENTRY.exec(line.trim());
    if (match) hints.push({ lawName, article: match[1]!, title: match[2]!.trim(), text: match[3]!.trim(), tags, ...(sourceUrl ? { sourceUrl } : {}) });
  }
  return hints;
}

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const word of searchWords(text)) for (let index = 0; index + 2 <= word.length; index += 1) grams.add(word.slice(index, index + 2));
  return grams;
}

const overlap = (left: Set<string>, right: Set<string>): number => [...left].filter(gram => right.has(gram)).length;

/**
 * Ranks curated key articles against a question. A tag the question clearly mentions (해고, 개인정보 …) selects the
 * page's articles, and overlap with an article's own title and text orders them. Nothing is returned without a tag or
 * a title match, so unrelated questions get no hints.
 */
export function matchWikiHints(question: string, hints: readonly WikiHint[], max: number): WikiHintMatch[] {
  const asked = bigrams(question);
  if (asked.size === 0) return [];
  const scored = hints.map(hint => {
    const tagMatches = hint.tags.filter(tag => {
      const tagGrams = bigrams(tag);
      return tagGrams.size > 0 && overlap(tagGrams, asked) >= Math.min(2, tagGrams.size);
    }).length;
    const titleOverlap = overlap(bigrams(hint.title), asked);
    const textOverlap = overlap(bigrams(hint.text), asked);
    const eligible = tagMatches > 0 || titleOverlap >= 2;
    // The tags belong to the whole page, so every article on it shares them; counting each matching tag would let a page
    // with many tags push its unrelated articles above an article whose own title and text match the question.
    return { hint, eligible, score: (tagMatches > 0 ? 4 : 0) + 3 * titleOverlap + textOverlap };
  });
  const best = new Map<string, (typeof scored)[number]>();
  for (const item of scored) {
    const key = `${item.hint.lawName}|${item.hint.article}`;
    if (item.eligible && item.score >= 5 && (best.get(key)?.score ?? -1) < item.score) best.set(key, item);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ hint }) => ({ lawName: hint.lawName, article: hint.article, title: hint.title, ...(hint.sourceUrl ? { sourceUrl: hint.sourceUrl } : {}) }));
}

/** Curated key-article lists kept in the legal wiki folder; loaded once and reloaded only if the folder is empty. */
export class LegalWikiHints {
  private loaded?: Promise<WikiHint[]>;

  /** `wikiRoots` are read in order; a folder that does not exist is skipped, so a repository supplement is optional. */
  constructor(wikiRoots: string | readonly string[]) {
    this.wikiRoots = typeof wikiRoots === 'string' ? [wikiRoots] : [...wikiRoots];
  }

  private readonly wikiRoots: string[];

  private load(): Promise<WikiHint[]> {
    this.loaded ??= (async () => {
      const pages = await Promise.all(this.wikiRoots.map(async root => {
        const files = (await readdir(root).catch(() => [] as string[])).filter(name => name.endsWith('.md'));
        return Promise.all(files.map(async name => parseWikiCore(await readFile(path.join(root, name), 'utf8').catch(() => ''))));
      }));
      return pages.flat(2);
    })();
    return this.loaded;
  }

  async find(question: string, max = 3): Promise<WikiHintMatch[]> {
    try {
      return matchWikiHints(question, await this.load(), max);
    } catch {
      this.loaded = undefined;
      return [];
    }
  }

  /** Official page URL for a law, from the wiki metadata; spacing in the law name is ignored. */
  async sourceUrlFor(lawName: string): Promise<string | undefined> {
    const squash = (value: string): string => value.replace(/\s+/g, '');
    const hints = await this.load().catch(() => [] as WikiHint[]);
    return hints.find(hint => hint.sourceUrl && squash(hint.lawName) === squash(lawName))?.sourceUrl;
  }
}
