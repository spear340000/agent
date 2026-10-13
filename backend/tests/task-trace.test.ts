import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskDetails, TaskEvent } from '../src/domain/task.ts';
import { buildTaskTrace } from '../src/application/task-trace.ts';

const origin = Date.parse('2026-10-13T00:00:00.000Z');
const at = (ms: number): string => new Date(origin + ms).toISOString();

function event(id: number, ms: number, type: string, title: string, extra: Partial<TaskEvent> = {}): TaskEvent {
  return { id, taskId: 't1', type, title, message: `${title} 메시지`, status: 'completed', createdAt: at(ms), ...extra };
}

function details(status: string, events: TaskEvent[]): TaskDetails {
  return {
    task: { id: 't1', prompt: 'q', title: 'q', sourceFileIds: [], sourceUrls: [], status, steps: [], createdAt: at(0), updatedAt: at(10_000) } as TaskDetails['task'],
    events,
    artifacts: []
  };
}

test('a finished task yields step, model and failure spans in time order, with the decisions as its trajectory', () => {
  const trace = buildTaskTrace(details('completed', [
    event(1, 100, 'step.started', '근거 검색'),
    event(2, 1_500, 'task.progress', '질의 재작성', { message: '질문을 두 개로 나눔' }),
    event(3, 2_000, 'step.completed', '근거 검색'),
    event(4, 3_000, 'step.started', '답변 작성'),
    event(5, 9_000, 'model.attempts', '모델 사용 기록', {
      metadata: {
        attempts: [
          { model: 'groq · a', ok: false, ms: 500, error: '분당 한도', startedAt: origin + 2_600 },
          { model: 'nvidia · b', ok: true, ms: 4_000, startedAt: origin + 3_100, promptTokens: 3_000, completionTokens: 400 }
        ]
      }
    }),
    event(6, 9_500, 'step.completed', '답변 작성'),
    event(7, 9_600, 'legal.answer', '법률 답변 준비됨'),
    event(8, 9_700, 'task.progress', '검증 실패', { status: 'failed', message: '검증 모델 응답 없음' })
  ]));

  assert.equal(trace.taskId, 't1');
  assert.equal(trace.status, 'completed');
  assert.equal(trace.totalMs, 9_700);

  const steps = trace.spans.filter(span => span.kind === 'step');
  assert.deepEqual(steps.map(span => [span.name, span.startMs, span.durationMs, span.status]), [['근거 검색', 100, 1_900, 'ok'], ['답변 작성', 3_000, 6_500, 'ok']]);

  const llm = trace.spans.filter(span => span.kind === 'llm');
  assert.deepEqual(llm.map(span => [span.name, span.startMs, span.durationMs, span.status]), [['groq · a', 2_600, 500, 'error'], ['nvidia · b', 3_100, 4_000, 'ok']]);
  assert.equal(llm[0]!.detail, '분당 한도');
  assert.equal(llm[1]!.promptTokens, 3_000);
  assert.equal(llm[1]!.completionTokens, 400);

  const errors = trace.spans.filter(span => span.kind === 'error');
  assert.deepEqual(errors.map(span => [span.name, span.startMs, span.detail]), [['검증 실패', 9_700, '검증 모델 응답 없음']]);

  assert.deepEqual(trace.spans.map(span => span.startMs), [...trace.spans.map(span => span.startMs)].sort((a, b) => a - b), 'spans are ordered by start');

  // Model and answer records are outcomes, not stage changes, so they stay out of the trajectory.
  assert.deepEqual(trace.trajectory.map(step => [step.order, step.title, step.offsetMs]), [
    [1, '근거 검색', 100],
    [2, '질의 재작성', 1_500],
    [3, '근거 검색', 2_000],
    [4, '답변 작성', 3_000],
    [5, '답변 작성', 9_500],
    [6, '검증 실패', 9_700]
  ]);
});

test('a model attempt recorded without a start time ends where the report was written', () => {
  const trace = buildTaskTrace(details('completed', [
    event(1, 5_000, 'model.attempts', '모델 사용 기록', { metadata: { attempts: [{ model: 'old · m', ok: true, ms: 2_000 }] } })
  ]));
  const [span] = trace.spans;
  assert.equal(span!.kind, 'llm');
  assert.equal(span!.startMs, 3_000);
  assert.equal(span!.durationMs, 2_000);
});

test('a step that never completes is running while the task runs and an error once it has stopped', () => {
  const events = [event(1, 0, 'step.started', '문서 작성'), event(2, 4_000, 'task.progress', '진행 중')];
  const running = buildTaskTrace(details('running', events)).spans.find(span => span.kind === 'step');
  assert.equal(running!.status, 'running');
  assert.equal(running!.durationMs, 4_000);
  const failed = buildTaskTrace(details('failed', events)).spans.find(span => span.kind === 'step');
  assert.equal(failed!.status, 'error');
});

test('a task with no events has an empty trace rather than an error', () => {
  const trace = buildTaskTrace(details('queued', []));
  assert.deepEqual(trace.spans, []);
  assert.deepEqual(trace.trajectory, []);
  assert.equal(trace.totalMs, 0);
});
