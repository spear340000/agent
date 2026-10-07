import type { LegalSource } from '../../domain/legal-source.js';

const ARTICLE_REF = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g;
const LAW_SUFFIX = /(?:법률|법|령|규칙|조례)$/u;
const CLOSERS = /[」』)\]"'”’]+$/u;
// "같은 법 제5조", "동법 제5조": the law is whichever was just named, so it cannot be checked on its own.
const ANAPHORIC_LAW = /(?:같은법|동법|이법|그법|본법|위법률|같은법률)$/u;

/** An article named in text; `law` is the squashed law name written right before it, when there is one. */
export type ArticleRef = { key: string; law?: string; label?: string };

const squash = (value: string): string => value.replace(/\s+/g, '');

/** The last words before an article reference, after any punctuation, with closing quotes removed. */
function precedingWords(text: string, at: number): string[] {
  const window = text.slice(Math.max(0, at - 40), at).replace(CLOSERS, '').trimEnd();
  const tail = window.split(/[^가-힣A-Za-z0-9·ㆍ\s]/u).pop() ?? '';
  return tail.split(/\s+/).filter(Boolean);
}

export function articleRefs(text: string): ArticleRef[] {
  return [...text.matchAll(ARTICLE_REF)].map(match => {
    const key = match[2] ? `${match[1]}-${match[2]}` : match[1]!;
    const words = precedingWords(text, match.index ?? 0);
    const law = squash(words.slice(-3).join(''));
    if (!LAW_SUFFIX.test(law) || ANAPHORIC_LAW.test(law)) return { key };
    return { key, law, label: words.slice(-2).join(' ') };
  });
}

/** Articles a record is *about* (its own number, label and title), tied to its law, not every article its text mentions. */
export function sourceIdentityRefs(source: LegalSource): ArticleRef[] {
  const law = source.lawName ? squash(source.lawName) : undefined;
  return articleRefs([source.articleNumber, source.articleLabel, source.title].filter(Boolean).join(' ')).map(ref => ({ key: ref.key, ...(law ? { law } : {}) }));
}

/** Identity plus the articles quoted in the record's own text (law unknown); for sentences that cite that record. */
export function sourceArticleRefs(source: LegalSource): ArticleRef[] {
  return [...sourceIdentityRefs(source), ...articleRefs(source.excerpt ?? '').map(ref => ({ key: ref.key }))];
}

/** A named article is covered by a record about the same article number and, when both name a law, the same law. */
export function coversArticle(records: readonly ArticleRef[], ref: ArticleRef): boolean {
  return records.some(record =>
    record.key === ref.key && (!ref.law || !record.law || ref.law.endsWith(record.law) || record.law.endsWith(ref.law))
  );
}

export function articleDisplay(ref: ArticleRef): string {
  const [number, branch] = ref.key.split('-');
  return `${ref.label ? `${ref.label} ` : ''}제${number}조${branch ? `의${branch}` : ''}`;
}
