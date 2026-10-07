import { LegalRetrievalError } from '../../domain/legal-error.js';
import { normalizeLawRecord, type NormalizedRecord } from './legal-normalization.js';

const ORIGIN = 'https://www.law.go.kr';
const compact = (text: string): string => text.replace(/\s+/g, '');
const textOf = (html: string): string => html
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value: string) => {
    const code = value.startsWith('x') ? parseInt(value.slice(1), 16) : Number(value);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  })
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name]!)
  .replace(/\s+/g, ' ').trim();

/** Reads an official search result and its exact article; never supplies statutory text from a template. */
export class OfficialLawArticleReader {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async read(lawName: string, articleNumber: string, signal?: AbortSignal): Promise<NormalizedRecord[]> {
    signal?.throwIfAborted();
    const article = /^제(\d+)조(?:의(\d+))?$/.exec(compact(articleNumber));
    if (!article || !lawName.trim()) throw new LegalRetrievalError('not-found', '법령명과 조문 번호를 확인해 주세요.');
    const boundedSignal = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
    const listing = await this.request(new URL('/LSW/lsScListR.do?menuId=1&subMenuId=15&tabMenuId=81', ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: lawName, outmax: '50', p18: '0', pg: '1', lsType: 'null', section: 'lawNm', lsiSeq: '0', p9: '2,4' }).toString(),
      signal: boundedSignal,
    });
    const candidates = new Map<string, { name: string; sequence: string; effective?: number }>();
    for (const match of listing.matchAll(/<a\b([^>]+)>/gi)) {
      const attributes = match[1]!;
      const sequence = /lsViewWideAll\(\s*['"](\d+)['"]/.exec(attributes)?.[1];
      const title = /\btitle="([^"]*)"/i.exec(attributes)?.[1];
      if (!sequence || !title) continue;
      const name = textOf(title.split(/[\r\n\[]/)[0]!);
      if (compact(name) === compact(lawName) || compact(name).endsWith(compact(lawName))) {
        const date = /시행\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./.exec(title);
        const effective = date ? Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])) : undefined;
        if (effective === undefined || effective <= Date.now()) candidates.set(sequence, { name, sequence, effective });
      }
    }
    const exact = [...candidates.values()].filter(candidate => compact(candidate.name) === compact(lawName));
    let matches = exact.length ? exact : [...candidates.values()];
    if (new Set(matches.map(candidate => compact(candidate.name))).size === 1 && matches.every(candidate => candidate.effective !== undefined)) {
      const latest = Math.max(...matches.map(candidate => candidate.effective!));
      matches = matches.filter(candidate => candidate.effective === latest);
    }
    if (matches.length !== 1) throw new LegalRetrievalError('not-found', matches.length
      ? '공식 검색에서 여러 법령이 일치합니다. 정확한 법령명을 지정해 주세요.'
      : '공식 검색에서 요청한 법령명을 확인하지 못했습니다.');
    const selected = matches[0]!;
    const url = new URL('/LSW/lsSideInfoP.do', ORIGIN);
    url.search = new URLSearchParams({
      lsiSeq: selected.sequence,
      joNo: article[1]!.padStart(4, '0'),
      joBrNo: (article[2] ?? '0').padStart(2, '0'),
      docCls: 'jo', urlMode: 'lsScJoRltInfoR',
    }).toString();
    const html = await this.request(url, { signal: boundedSignal });
    const name = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)]
      .map(match => textOf(match[1]!)).find(title => compact(title) === compact(selected.name)) ?? '';
    if (compact(name) !== compact(selected.name)) throw new LegalRetrievalError('not-found', '공식 페이지의 법령명이 요청한 법령과 일치하지 않습니다.');
    let paragraphs: string[] = [];
    for (const block of html.split(/<div\b[^>]*class=["']pgroup["'][^>]*>/i).slice(1)) {
      const lines = [...block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(match => textOf(match[1]!)).filter(Boolean);
      const heading = /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?(?!\d)/.exec(lines[0] ?? '');
      if (heading && heading[1] === article[1] && heading[2] === article[2]) {
        paragraphs = lines;
        break;
      }
    }
    if (!paragraphs.length) throw new LegalRetrievalError('not-found', '공식 페이지에서 요청한 조문 원문을 확인하지 못했습니다.');
    const record = normalizeLawRecord(name, '', `##### ${paragraphs.join('\n\n')}`, { lawName: name, articleNumber: compact(articleNumber) });
    record.officialUrl = url.toString();
    return [record];
  }

  private async request(url: URL, init: RequestInit): Promise<string> {
    const response = await this.fetcher(url, { ...init, redirect: 'error' });
    if (!response.ok) throw new LegalRetrievalError('tool-error', `공식 법령 원문 요청이 HTTP ${response.status}로 실패했습니다.`);
    if (!response.body) throw new LegalRetrievalError('malformed', '공식 법령 응답 본문이 없습니다.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) throw new LegalRetrievalError('malformed', '공식 법령 응답 크기가 제한을 초과했습니다.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks).toString('utf8');
  }
}

