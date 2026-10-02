export function findInvalidCitations(text: string, validSourceIds: string[]): string[] {
  const valid = new Set(validSourceIds);
  return [...new Set(Array.from(text.matchAll(/\[(PDF\d+|W\d+)\]/g), match => match[1]!).filter(id => !valid.has(id)))];
}
