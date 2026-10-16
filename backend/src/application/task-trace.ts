import type { TaskDetails, TaskEvent } from '../domain/task.js';
import type { TaskTrace, TraceSpan, TraceStage, TrajectoryStep } from '../domain/trace.js';

/** Events that record a decision, a change of stage or how the task ended; their order is the task's trajectory. */
const TRAJECTORY_TYPES = new Set([
  'task.progress',
  'step.started',
  'step.completed',
  'legal.routed',
  'legal.retrieval',
  'legal.answer',
  'task.completed',
  'task.failed',
  'task.cancelled'
]);

/** Progress lines written for each model call. Their timing is already a model span, so they are left out of the trajectory. */
const MODEL_CALL_PROGRESS = new Set(['모델 응답', '모델 호출 실패 · 다음 모델로 전환']);

/** Stage of a step by its key (the stable id the agent gives each step). */
const STAGE_BY_KEY: Record<string, TraceStage> = {
  'legal:documents': 'retrieve',
  'legal:plan': 'classify',
  'legal:retrieve': 'retrieve',
  'legal:web': 'retrieve',
  'legal:verify': 'verify',
  'legal:write:v2': 'answer'
};

/** Stage by step title, for steps recorded before keys were added and for non-legal steps. */
const STAGE_BY_TITLE: Record<string, TraceStage> = {
  '첨부 자료 확인': 'retrieve',
  '검색 계획 수립': 'classify',
  '제한된 근거 수집': 'retrieve',
  '법령·판례 근거 확인': 'retrieve',
  '공개 웹 자료 확인': 'retrieve',
  '근거 검증': 'verify',
  '근거 기반 답변 작성': 'answer',
  '근거 기반 답변·초안 작성': 'answer',
  'Plan task': 'classify',
  'Read source files': 'retrieve',
  'Research the web': 'retrieve',
  'Analyze evidence': 'answer',
  'Generate cited DOCX': 'answer'
};

export function stageOf(key: unknown, title: string): TraceStage | undefined {
  return (typeof key === 'string' ? STAGE_BY_KEY[key] : undefined) ?? STAGE_BY_TITLE[title];
}

type Attempt = { model?: unknown; ok?: unknown; ms?: unknown; error?: unknown; startedAt?: unknown; promptTokens?: unknown; completionTokens?: unknown };

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function llmSpan(attempt: Attempt, startMs: number, estimated: boolean): TraceSpan {
  return {
    kind: 'llm',
    name: String(attempt.model ?? 'model'),
    startMs,
    durationMs: numberOr(attempt.ms, 0),
    status: attempt.ok === true ? 'ok' : 'error',
    ...(typeof attempt.error === 'string' ? { detail: attempt.error.slice(0, 200) } : {}),
    ...(typeof attempt.promptTokens === 'number' ? { promptTokens: attempt.promptTokens } : {}),
    ...(typeof attempt.completionTokens === 'number' ? { completionTokens: attempt.completionTokens } : {}),
    ...(estimated ? { estimated: true } : {})
  };
}

/**
 * Builds the trace of a task from the events it already recorded. Nothing is stored twice: the spans come from step
 * events, model calls and failures, and the trajectory is the ordered list of decisions and stage changes.
 *
 * `now` is the moment the trace is read. A task that is still running has no end yet, so its open steps and total time
 * run up to `now`.
 */
export function buildTaskTrace(details: TaskDetails, now: number = Date.now()): TaskTrace {
  const origin = Date.parse(details.task.createdAt);
  const at = (event: TaskEvent): number => Math.max(0, Date.parse(event.createdAt) - origin);
  const events = [...details.events].sort((left, right) => left.id - right.id);
  const status = details.task.status;
  const running = status === 'queued' || status === 'running';
  const lastEventMs = events.reduce((max, event) => Math.max(max, at(event)), 0);
  const lastMs = running ? Math.max(lastEventMs, Math.max(0, now - origin)) : lastEventMs;
  const spans: TraceSpan[] = [];

  // Step spans run from their "started" event to their "completed" event. A step still open when the task ends is marked
  // as cancelled or failed; a step still open while the task runs is running and ends at the read time.
  const openSteps = new Map<string, { startMs: number; stage?: TraceStage; reused: boolean }>();
  for (const event of events) {
    if (event.type === 'step.started') {
      openSteps.set(event.title, { startMs: at(event), stage: stageOf(event.metadata?.key, event.title), reused: event.metadata?.reused === true });
    }
    if (event.type === 'step.completed' && openSteps.has(event.title)) {
      const open = openSteps.get(event.title)!;
      spans.push({
        kind: 'step',
        name: event.title,
        startMs: open.startMs,
        durationMs: at(event) - open.startMs,
        status: 'ok',
        ...(open.stage ? { stage: open.stage } : {}),
        ...(open.reused ? { detail: '이전 실행에서 재사용' } : {})
      });
      openSteps.delete(event.title);
    }
  }
  for (const [name, open] of openSteps) {
    const status: TraceSpan['status'] = running ? 'running' : details.task.status === 'cancelled' ? 'cancelled' : 'error';
    spans.push({
      kind: 'step',
      name,
      startMs: open.startMs,
      durationMs: Math.max(0, lastMs - open.startMs),
      status,
      ...(open.stage ? { stage: open.stage } : {})
    });
  }

  // Model calls. Newer tasks record each call as it finishes ('model.attempt'), so a running task shows them too. Older
  // tasks only have a summary list in 'model.attempts'; those calls are used only when no per-call record exists, which
  // avoids counting one call twice.
  const perCall = events.filter(event => event.type === 'model.attempt');
  if (perCall.length > 0) {
    for (const event of perCall) {
      const attempt = (event.metadata ?? {}) as Attempt;
      const recorded = typeof attempt.startedAt === 'number';
      const startMs = recorded ? Math.max(0, (attempt.startedAt as number) - origin) : Math.max(0, at(event) - numberOr(attempt.ms, 0));
      spans.push(llmSpan(attempt, startMs, !recorded));
    }
  } else {
    for (const event of events) {
      if (event.type !== 'model.attempts') continue;
      const attempts = Array.isArray(event.metadata?.attempts) ? (event.metadata.attempts as Attempt[]) : [];
      const end = at(event);
      for (const attempt of attempts) {
        const recorded = typeof attempt.startedAt === 'number';
        const startMs = recorded ? Math.max(0, (attempt.startedAt as number) - origin) : Math.max(0, end - numberOr(attempt.ms, 0));
        spans.push(llmSpan(attempt, startMs, !recorded));
      }
    }
  }

  // A failure that is already a failed step is shown once, on the step. Other failures are error spans of their own.
  const stepFailed = spans.some(span => span.kind === 'step' && span.status === 'error');
  for (const event of events) {
    if (event.status !== 'failed' || event.type === 'step.completed') continue;
    if (event.type === 'task.failed' && stepFailed) continue;
    spans.push({ kind: 'error', name: event.title, startMs: at(event), durationMs: 0, status: 'error', detail: event.message.slice(0, 200) });
  }

  spans.sort((left, right) => left.startMs - right.startMs);

  const trajectory: TrajectoryStep[] = events
    .filter(event => TRAJECTORY_TYPES.has(event.type))
    .filter(event => !(event.type === 'task.progress' && MODEL_CALL_PROGRESS.has(event.title)))
    .map((event, index) => ({ order: index + 1, offsetMs: at(event), title: event.title, detail: event.message }));

  return { taskId: details.task.id, status, totalMs: lastMs, spans, trajectory };
}
