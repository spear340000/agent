import assert from 'node:assert/strict';
import test from 'node:test';
import { OfficialLawArticleReader } from '../src/infrastructure/legal/official-law-article-reader.ts';

const list = '<a onclick="lsViewWideAll(\'42\',\'20200101\')" title="푸른하늘법\n[시행 2020. 1. 1.]">푸른하늘법</a>';
const article = '<h2>푸른하늘법</h2><div class="ct_sub">[시행 2020. 1. 1.]</div><div class="pgroup"><p><label>제3조의2(범위)</label>①첫째 항 원문</p><p>②둘째 항 원문</p></div><div class="pgroup"><p>부칙</p></div>';

test('official lookup resolves a unique source-backed name and returns only the requested article', async () => {
  const urls: string[] = [];
  const reader = new OfficialLawArticleReader(async (url, init) => {
    urls.push(String(url));
    if (urls.length === 1) {
      assert.equal(new URLSearchParams(String(init?.body)).get('q'), '하늘법');
      return new Response(list);
    }
    return new Response('<h2>법령</h2>' + article);
  });
  const [record] = await reader.read('하늘법', '제3조의2');
  assert.equal(record?.lawName, '푸른하늘법');
  assert.equal(record?.articleNumber, '제3조의2');
  assert.match(record!.excerpt, /첫째 항 원문/);
  assert.match(record!.excerpt, /둘째 항 원문/);
  assert.doesNotMatch(record!.excerpt, /부칙/);
  assert.match(record!.officialUrl!, /lsiSeq=42/);
  assert.equal(new URL(urls[1]!).searchParams.get('joBrNo'), '02');
});

test('ambiguous official law names are not guessed', async () => {
  const reader = new OfficialLawArticleReader(async () => new Response(list +
    '<a onclick="lsViewWideAll(\'43\',\'20200101\')" title="다른하늘법\n[시행 2020. 1. 1.]">다른하늘법</a>'));
  await assert.rejects(reader.read('하늘법', '제3조의2'), /여러 법령/);
});

test('cross-references and wrong article headings cannot masquerade as an exact article', async () => {
  let calls = 0;
  const reader = new OfficialLawArticleReader(async () => new Response(++calls === 1 ? list : article.replace('제3조의2(범위)', '제30조(범위)')));
  await assert.rejects(reader.read('푸른하늘법', '제3조의2'), /조문 원문/);
});

test('official source failure and cancellation do not generate a law record', async () => {
  const reader = new OfficialLawArticleReader(async () => new Response('service unavailable', { status: 503 }));
  await assert.rejects(reader.read('푸른하늘법', '제3조'), /503/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reader.read('푸른하늘법', '제3조', controller.signal));
});

