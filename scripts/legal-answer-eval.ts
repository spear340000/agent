// End-to-end answer check against the RUNNING backend: for a fixed question set it records whether the articles a
// competent answer needs were retrieved, whether the answer cites anything, whether it refused, and whether it states
// anything it must not. Run each case several times because the answer model is not deterministic.
// Usage: npm run eval:answers -- [--runs 2] [--only 3,5] [--base http://127.0.0.1:8787]
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type Case = {
  id: number;
  question: string;
  /** Statute articles that must be among the retrieved records (spacing ignored). */
  retrieve: Array<{ law: string; article: string }>;
  /** Every pattern must appear in the answer text. */
  mention?: RegExp[];
  /** No pattern may appear in the answer text. */
  forbid?: RegExp[];
};

const CASES: Case[] = [
  { id: 1, question: '민법 제750조 내용 알려줘', retrieve: [{ law: '민법', article: '750' }], mention: [/고의 또는 과실/] },
  { id: 2, question: '대법원 2018다248855 판결 요지가 뭐야?', retrieve: [], mention: [/위약벌/], forbid: [/결론을 제시할 수 없습니다/] },
  { id: 3, question: '회사에서 갑자기 해고당했는데 부당해고 구제 신청은 어떻게 하나요?', retrieve: [{ law: '근로기준법', article: '28' }, { law: '근로기준법', article: '23' }], mention: [/3개월/], forbid: [/2년 이내/] },
  { id: 4, question: '임대차 계약 갱신요구권과 묵시적 갱신의 차이를 알려주세요.', retrieve: [{ law: '주택임대차보호법', article: '6의3' }, { law: '주택임대차보호법', article: '6' }] },
  { id: 5, question: '교통사고로 다쳤는데 합의금은 어떻게 산정하고, 보험사가 거절하면 어떻게 하나요? 그리고 형사처벌도 받나요?', retrieve: [{ law: '민법', article: '750' }] },
  { id: 6, question: '친구에게 빌려준 돈 500만원을 돌려받기 위한 내용증명 초안을 작성해주세요.', retrieve: [{ law: '민법', article: '598' }, { law: '민법', article: '603' }] },
  { id: 7, question: '민법 제398조 위약벌과 손해배상 예정액의 차이를 알려주세요.', retrieve: [{ law: '민법', article: '398' }], mention: [/감액/], forbid: [/명칭에 불과/] },
  { id: 8, question: '보증금을 돌려받지 못한 채 이사하려면 임차권등기명령은 어떻게 신청하나요?', retrieve: [{ law: '주택임대차보호법', article: '3의3' }] },
  { id: 9, question: '상속 1순위는 누구이고 상속포기는 언제까지 해야 하나요?', retrieve: [{ law: '민법', article: '1000' }, { law: '민법', article: '1019' }], mention: [/3개월/] },
  { id: 10, question: '직장 내 괴롭힘을 당했을 때 신고하면 어떻게 처리되나요?', retrieve: [{ law: '근로기준법', article: '76의3' }] },
  { id: 11, question: '개인정보가 유출되면 회사는 어떤 책임을 지나요?', retrieve: [{ law: '개인정보 보호법', article: '34' }] },
  { id: 12, question: '정당방위는 어떤 경우에 인정되나요?', retrieve: [{ law: '형법', article: '21' }] },
  { id: 13, question: '월세를 2기 이상 연체하면 집주인이 계약을 해지할 수 있나요?', retrieve: [{ law: '민법', article: '640' }] },
  { id: 14, question: '계약을 체결한 뒤 상대방이 이행하지 않으면 계약을 해제할 수 있나요?', retrieve: [{ law: '민법', article: '544' }] },
  { id: 15, question: '소멸시효는 보통 몇 년인가요?', retrieve: [{ law: '민법', article: '162' }] }
];

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const runs = Math.max(1, Number(option('runs', '1')));
const only = new Set(option('only', '').split(',').filter(Boolean).map(Number));
const base = option('base', 'http://127.0.0.1:8787');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const token = (readFileSync(path.join(root, '.env'), 'utf8').match(/^API_AUTH_TOKEN=(.*)$/m)?.[1] ?? '').trim().replace(/^"|"$/g, '');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };
const squash = (value: string): string => value.replace(/\s+/g, '');

type Source = { lawName?: string; articleNumber?: string; title?: string };
type Result = { id: number; run: number; retrieved: string; cited: number; refused: boolean; mention: boolean; forbid: boolean; checked: boolean; seconds: number; error?: string };

async function ask(question: string): Promise<{ answer: string; sources: Source[]; cited: number; checked: boolean; failed?: string }> {
  const created = (await (await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ prompt: question, mode: 'legal' }) })).json()) as { task?: { id: string }; id?: string };
  const id = created.task?.id ?? created.id;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 4000));
    const details = (await (await fetch(`${base}/api/tasks/${id}`, { headers })).json()) as { task: { status: string; error?: string }; events: Array<{ type: string; metadata?: Record<string, unknown> }> };
    if (details.task.status === 'failed') return { answer: '', sources: [], cited: 0, checked: false, failed: details.task.error ?? 'failed' };
    if (details.task.status !== 'completed') continue;
    const metadata = details.events.find(event => event.type === 'legal.answer')?.metadata as { answer?: string; sources?: Source[]; citations?: unknown[]; sourceStatus?: { chain?: Array<{ id: string; summary: string }> } } | undefined;
    const agent = metadata?.sourceStatus?.chain?.find(stage => stage.id === 'agent')?.summary ?? '';
    return { answer: metadata?.answer ?? '', sources: metadata?.sources ?? [], cited: metadata?.citations?.length ?? 0, checked: !agent.includes('의미 검증 미수행') };
  }
  return { answer: '', sources: [], cited: 0, checked: false, failed: 'timed out' };
}

function retrievedLabel(sources: Source[], needed: Case['retrieve']): string {
  if (needed.length === 0) return '-';
  const hits = needed.filter(item => {
    const needle = `제${item.article.replace('의', '조의')}${item.article.includes('의') ? '' : '조'}`;
    return sources.some(source => {
      const label = squash(`${source.lawName ?? ''}${source.title ?? ''}${source.articleNumber ?? ''}`);
      return label.includes(squash(item.law)) && new RegExp(`${needle}(?!\d)`).test(label);
    });
  });
  return `${hits.length}/${needed.length}`;
}

const results: Result[] = [];
for (const item of CASES.filter(entry => only.size === 0 || only.has(entry.id))) {
  for (let run = 1; run <= runs; run += 1) {
    const started = Date.now();
    try {
      const outcome = await ask(item.question);
      const refused = /결론을 제시할 수 없습니다/.test(outcome.answer) || outcome.answer.trim() === '';
      results.push({
        id: item.id,
        run,
        retrieved: retrievedLabel(outcome.sources, item.retrieve),
        cited: outcome.cited,
        refused,
        mention: (item.mention ?? []).every(pattern => pattern.test(outcome.answer)),
        forbid: (item.forbid ?? []).some(pattern => pattern.test(outcome.answer)),
        checked: outcome.checked,
        seconds: Math.round((Date.now() - started) / 1000),
        ...(outcome.failed ? { error: outcome.failed } : {})
      });
    } catch (error) {
      results.push({ id: item.id, run, retrieved: '?', cited: 0, refused: true, mention: false, forbid: false, checked: false, seconds: 0, error: error instanceof Error ? error.message : String(error) });
    }
    const last = results.at(-1)!;
    console.log(`Q${String(last.id).padStart(2)} run${run} retrieved=${last.retrieved} cited=${last.cited} refused=${last.refused} mention=${last.mention} forbidden=${last.forbid} verified=${last.checked} ${last.seconds}s${last.error ? ` ERROR ${last.error}` : ''}`);
  }
}

const complete = results.filter(result => {
  const [hit, total] = result.retrieved.split('/').map(Number);
  return !result.error && !result.refused && !result.forbid && result.mention && (result.retrieved === '-' || hit === total);
}).length;
const share = (count: number): string => `${count}/${results.length}`;
console.log('\n=== summary ===');
console.log(`passed (retrieved all, answered, no forbidden claim, required mentions): ${share(complete)}`);
console.log(`refused or empty: ${share(results.filter(result => result.refused).length)}`);
console.log(`forbidden claim present: ${share(results.filter(result => result.forbid).length)}`);
console.log(`verification skipped: ${share(results.filter(result => !result.checked).length)}`);
writeFileSync(path.join(tmpdir(), 'legal-answer-eval.json'), JSON.stringify({ at: new Date().toISOString(), runs, results }, null, 2));
