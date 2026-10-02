export type TextReplacement = { find: string; replace: string };
const WORD_TEXT_BARRIERS = /<w:(?:tab|br|cr|ptab|fldChar|instrText|drawing|object|pict|sym|softHyphen|noBreakHyphen|lastRenderedPageBreak|footnoteReference|endnoteReference|commentReference|separator|continuationSeparator|hyperlink|sdt|smartTag|customXml|ins|del|moveFrom|moveTo|bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|permStart|permEnd)\b/i;

export function decodeXmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
    const known: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (known[entity]) return known[entity]!;
    const numeric = /^&#(x[0-9a-f]+|\d+);$/i.exec(entity);
    if (!numeric) return entity;
    const codePoint = numeric[1]!.toLowerCase().startsWith('x') ? Number.parseInt(numeric[1]!.slice(1), 16) : Number(numeric[1]);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

function encodeXml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function replaceInText(value: string, replacement: TextReplacement): { value: string; count: number } {
  const decoded = decodeXmlText(value);
  const pieces = decoded.split(replacement.find);
  const count = pieces.length - 1;
  return { value: count ? encodeXml(pieces.join(replacement.replace)) : value, count };
}

function wordTextNode(attributes: string, text: string): string {
  const preserve = /^\s|\s$/.test(text);
  const withoutSpace = attributes.replace(/\s+xml:space=(?:"[^"]*"|'[^']*')/g, '');
  const nextAttributes = preserve ? `${withoutSpace} xml:space="preserve"` : withoutSpace;
  return `<w:t${nextAttributes}>${encodeXml(text)}</w:t>`;
}

function replaceAcrossWordRuns(paragraph: string, replacement: TextReplacement): { value: string; count: number } {
  const nodes: Array<{ start: number; end: number; attributes: string; text: string; group: number }> = [];
  const matcher = /<w:t((?:\s[^<>]*?)?)>([\s\S]*?)<\/w:t>/g;
  let group = 0;
  let previousEnd = 0;
  for (const match of paragraph.matchAll(matcher)) {
    const start = match.index!;
    const whole = match[0];
    if (nodes.length && WORD_TEXT_BARRIERS.test(paragraph.slice(previousEnd, start))) group++;
    nodes.push({ start, end: start + whole.length, attributes: match[1] ?? '', text: decodeXmlText(match[2] ?? ''), group });
    previousEnd = start + whole.length;
  }
  let count = 0;
  while (nodes.length) {
    let replaced = false;
    for (let segmentStart = 0; segmentStart < nodes.length;) {
      let segmentEnd = segmentStart + 1;
      while (segmentEnd < nodes.length && nodes[segmentEnd]!.group === nodes[segmentStart]!.group) segmentEnd++;
      const segment = nodes.slice(segmentStart, segmentEnd);
      const matchAt = segment.map(node => node.text).join('').indexOf(replacement.find);
      if (matchAt >= 0) {
        const finishAt = matchAt + replacement.find.length;
        let cursor = 0;
        let first = -1;
        let last = -1;
        let firstOffset = 0;
        let lastOffset = 0;
        for (let index = 0; index < segment.length; index++) {
          const next = cursor + segment[index]!.text.length;
          if (first < 0 && matchAt < next) { first = index; firstOffset = matchAt - cursor; }
          if (finishAt <= next) { last = index; lastOffset = finishAt - cursor; break; }
          cursor = next;
        }
        if (first >= 0 && last >= 0) {
          const firstNode = nodes[segmentStart + first]!;
          if (first === last) firstNode.text = `${firstNode.text.slice(0, firstOffset)}${replacement.replace}${firstNode.text.slice(lastOffset)}`;
          else {
            firstNode.text = `${firstNode.text.slice(0, firstOffset)}${replacement.replace}`;
            for (let index = first + 1; index < last; index++) nodes[segmentStart + index]!.text = '';
            const lastNode = nodes[segmentStart + last]!;
            lastNode.text = lastNode.text.slice(lastOffset);
          }
          count++;
          replaced = true;
          break;
        }
      }
      segmentStart = segmentEnd;
    }
    if (!replaced) break;
  }
  if (!count) return { value: paragraph, count };
  let result = '';
  let cursor = 0;
  for (const node of nodes) {
    result += paragraph.slice(cursor, node.start);
    result += wordTextNode(node.attributes, node.text);
    cursor = node.end;
  }
  return { value: result + paragraph.slice(cursor), count };
}

export function replaceDocxXmlText(xml: string, replacement: TextReplacement): { value: string; count: number } {
  if (!replacement.find) return { value: xml, count: 0 };
  let count = 0;
  let value = xml.replace(/<w:p(?:\s[^<>]*?)?>[\s\S]*?<\/w:p>/g, paragraph => {
    const result = replaceAcrossWordRuns(paragraph, replacement);
    count += result.count;
    return result.value;
  });
  value = value.replace(/<([A-Za-z_][\w:.-]*)(\s[^<>]*)?>([^<>]*)<\/\1>/g, (whole, _tag: string, _attrs: string, text: string) => {
    const result = replaceInText(text, replacement);
    count += result.count;
    return result.count ? whole.replace(text, result.value) : whole;
  });
  return { value, count };
}

export function findDocxXmlTextMatches(xml: string, pattern: RegExp): string[] {
  const paragraphTexts: string[] = [];
  const withoutParagraphs = xml.replace(/<w:p(?:\s[^<>]*?)?>[\s\S]*?<\/w:p>/g, paragraph => {
    paragraphTexts.push([...paragraph.matchAll(/<w:t(?:\s[^<>]*?)?>([\s\S]*?)<\/w:t>/g)].map(match => decodeXmlText(match[1] ?? '')).join(''));
    return '';
  });
  const leafTexts = [...withoutParagraphs.matchAll(/<([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?>([^<>]*)<\/\1>/g)].map(match => decodeXmlText(match[2] ?? ''));
  const matches: string[] = [];
  for (const text of [...paragraphTexts, ...leafTexts]) {
    const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(matcher)) if (match[0]) matches.push(match[0]);
  }
  return matches;
}
