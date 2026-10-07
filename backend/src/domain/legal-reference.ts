const NAMED_ARTICLE = /([가-힣][가-힣 \t·ㆍ]{0,100}?)\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/;
export const ARTICLE_NUMBER_PATTERN = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/;
const LAW_NAME_SUFFIX = /(?:법률|법|령|규칙|조칙|고시|지침)$/;

/** Parses the user's citation syntax without guessing a statute or rewriting a search query. */
export function extractLawArticle(prompt: string): { lawName?: string; articleNumber: string } | undefined {
  const text = prompt.replace(/\s+/g, ' ').trim();
  for (const match of text.matchAll(new RegExp(NAMED_ARTICLE, 'g'))) {
    const lawName = match[1]!.trim();
    if (LAW_NAME_SUFFIX.test(lawName)) {
      return { lawName, articleNumber: `제${match[2]}조${match[3] ? `의${match[3]}` : ''}` };
    }
  }
  const bare = ARTICLE_NUMBER_PATTERN.exec(text);
  return bare ? { articleNumber: `제${bare[1]}조${bare[2] ? `의${bare[2]}` : ''}` } : undefined;
}

