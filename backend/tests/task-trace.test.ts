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

  // Answer and end-of-task records are part of the decision order; model call summaries are not.
  assert.deepEqual(trace.trajectory.map(step => [step.order, step.title, step.offsetMs]), [
    [1, '근거 검색', 100],
    [2, '질의 재작성', 1_500],
    [3, '근거 검색', 2_000],
    [4, '답변 작성', 3_000],
    [5, '답변 작성', 9_500],
    [6, '법률 답변 준비됨', 9_600],
    [7, '검증 실패', 9_700]
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
  const running = buildTaskTrace(details('running', events), origin + 4_000).spans.find(span => span.kind === 'step');
  assert.equal(running!.status, 'running');
  assert.equal(running!.durationMs, 4_000);
  const failed = buildTaskTrace(details('failed', events)).spans.find(span => span.kind === 'step');
  assert.equal(failed!.status, 'error');
});

test('a task with no events has an empty trace rather than an error', () => {
  const trace = buildTaskTrace(details('queued', []), origin);
  assert.deepEqual(trace.spans, []);
  assert.deepEqual(trace.trajectory, []);
  assert.equal(trace.totalMs, 0);
});

test('a running task shows each model call as soon as it finished, and its total time runs up to the read time', () => {
  const trace = buildTaskTrace(details('running', [
    event(1, 1_000, 'step.started', '답변 작성'),
    event(2, 3_000, 'model.attempt', '모델 응답', { status: 'completed', metadata: { model: 'groq · a', ok: true, ms: 2_000, startedAt: origin + 1_000, promptTokens: 500, completionTokens: 90 } })
  ]), origin + 6_000);
  const llm = trace.spans.filter(span => span.kind === 'llm');
  assert.deepEqual(llm.map(span => [span.name, span.startMs, span.durationMs, span.status]), [['groq · a', 1_000, 2_000, 'ok']]);
  assert.equal(llm[0]!.estimated, undefined, 'a call with a recorded start is not estimated');
  assert.equal(trace.totalMs, 6_000);
  assert.equal(trace.spans.find(span => span.kind === 'step')!.durationMs, 5_000);
});

test('per-call records replace the summary list, so a call is never counted twice', () => {
  const trace = buildTaskTrace(details('completed', [
    event(1, 0, 'step.started', '답변 작성'),
    event(2, 1_000, 'model.attempt', '모델 응답', { metadata: { model: 'groq · a', ok: true, ms: 1_000, startedAt: origin } }),
    event(3, 2_000, 'model.attempts', '모델 사용 기록', { metadata: { attempts: [{ model: 'groq · a', ok: true, ms: 1_000, startedAt: origin }] } }),
    event(4, 2_500, 'step.completed', '답변 작성')
  ]));
  assert.equal(trace.spans.filter(span => span.kind === 'llm').length, 1);
});

test('a call without a recorded start is marked as estimated', () => {
  const trace = buildTaskTrace(details('completed', [
    event(1, 5_000, 'model.attempts', '모델 사용 기록', { metadata: { attempts: [{ model: 'old · m', ok: true, ms: 2_000 }] } })
  ]));
  assert.equal(trace.spans.find(span => span.kind === 'llm')!.estimated, true);
});

test('a reused step is shown with its reason, and a cancelled task marks its open step as cancelled', () => {
  const reused = buildTaskTrace(details('completed', [
    event(1, 0, 'step.started', '검색 계획 수립', { metadata: { key: 'legal:plan', reused: true } }),
    event(2, 0, 'step.completed', '검색 계획 수립', { metadata: { key: 'legal:plan', reused: true } })
  ]));
  const step = reused.spans.find(span => span.kind === 'step')!;
  assert.equal(step.detail, '이전 실행에서 재사용');
  assert.equal(step.stage, 'classify');

  const cancelled = buildTaskTrace(details('cancelled', [
    event(1, 0, 'step.started', '법령·판례 근거 확인', { metadata: { key: 'legal:retrieve' } }),
    event(2, 2_000, 'task.cancelled', 'Task cancelled', { status: 'cancelled' })
  ]));
  const open = cancelled.spans.find(span => span.kind === 'step')!;
  assert.equal(open.status, 'cancelled');
  assert.equal(open.stage, 'retrieve');
  assert.ok(cancelled.trajectory.some(step => step.title === 'Task cancelled'), 'the cancellation is part of the trajectory');
  assert.equal(cancelled.spans.filter(span => span.kind === 'error').length, 0, 'a cancellation is not an error span');
});

test('a failed step is shown once, and the model progress lines stay out of the trajectory', () => {
  const trace = buildTaskTrace(details('failed', [
    event(1, 0, 'step.started', '근거 기반 답변 작성', { metadata: { key: 'legal:write:v2' } }),
    event(2, 1_000, 'task.progress', '모델 응답', { message: 'groq · a 1.0초' }),
    event(3, 2_000, 'task.failed', 'Task failed', { status: 'failed', message: '모델 실패' })
  ]));
  assert.equal(trace.spans.filter(span => span.kind === 'step' && span.status === 'error').length, 1);
  assert.equal(trace.spans.filter(span => span.kind === 'error').length, 0, 'the failure is already the failed step');
  assert.deepEqual(trace.trajectory.map(step => step.title), ['근거 기반 답변 작성', 'Task failed']);
});

test('a step name the trace does not know has no stage rather than a wrong one', () => {
  const trace = buildTaskTrace(details('completed', [
    event(1, 0, 'step.started', '전혀 다른 단계'),
    event(2, 500, 'step.completed', '전혀 다른 단계')
  ]));
  assert.equal(trace.spans[0]!.stage, undefined);
});
