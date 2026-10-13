import type { TaskDetails, TaskEvent } from '../domain/task.js';
import type { TaskTrace, TraceSpan, TrajectoryStep } from '../domain/trace.js';

/** Events that record a decision or a change of stage; their order is the task's trajectory. */
const TRAJECTORY_TYPES = new Set(['task.progress', 'step.started', 'step.completed', 'legal.routed', 'legal.retrieval']);

type Attempt = { model?: unknown; ok?: unknown; ms?: unknown; error?: unknown; startedAt?: unknown; promptTokens?: unknown; completionTokens?: unknown };

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Builds the trace of a task from the events it already recorded. Nothing is stored twice: the spans come from step
 * events, model attempts and failures, and the trajectory is the ordered list of decisions and stage changes.
 */
export function buildTaskTrace(details: TaskDetails): TaskTrace {
  const origin = Date.parse(details.task.createdAt);
  const at = (event: TaskEvent): number => Math.max(0, Date.parse(event.createdAt) - origin);
  const events = [...details.events].sort((left, right) => left.id - right.id);
  const lastMs = events.reduce((max, event) => Math.max(max, at(event)), 0);
  const spans: TraceSpan[] = [];

  // Step spans run from their "started" event to their "completed" event; a step that never completed ends with the task.
  const openSteps = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'step.started') openSteps.set(event.title, at(event));
    if (event.type === 'step.completed' && openSteps.has(event.title)) {
      const startMs = openSteps.get(event.title) ?? 0;
      spans.push({ kind: 'step', name: event.title, startMs, durationMs: at(event) - startMs, status: 'ok' });
      openSteps.delete(event.title);
    }
  }
  const finished = ['completed', 'failed', 'cancelled'].includes(details.task.status);
  for (const [name, startMs] of openSteps) {
    spans.push({ kind: 'step', name, startMs, durationMs: Math.max(0, lastMs - startMs), status: finished ? 'error' : 'running' });
  }

  // Each model attempt is an llm span. Attempts carry their own start time when the provider recorded one; older
  // records only have a duration, which is placed so that it ends when the event that reported it was written.
  for (const event of events) {
    if (event.type !== 'model.attempts') continue;
    const attempts = Array.isArray(event.metadata?.attempts) ? (event.metadata.attempts as Attempt[]) : [];
    const end = at(event);
    for (const attempt of attempts) {
      const durationMs = numberOr(attempt.ms, 0);
      const startMs = typeof attempt.startedAt === 'number' ? Math.max(0, attempt.startedAt - origin) : Math.max(0, end - durationMs);
      spans.push({
        kind: 'llm',
        name: String(attempt.model ?? 'model'),
        startMs,
        durationMs,
        status: attempt.ok === true ? 'ok' : 'error',
        ...(typeof attempt.error === 'string' ? { detail: attempt.error.slice(0, 200) } : {}),
        ...(typeof attempt.promptTokens === 'number' ? { promptTokens: attempt.promptTokens } : {}),
        ...(typeof attempt.completionTokens === 'number' ? { completionTokens: attempt.completionTokens } : {})
      });
    }
  }

  // Failures recorded as events (not model attempts) are error spans so they appear on the timeline.
  for (const event of events) {
    if (event.status !== 'failed' || event.type === 'step.completed') continue;
    spans.push({ kind: 'error', name: event.title, startMs: at(event), durationMs: 0, status: 'error', detail: event.message.slice(0, 200) });
  }

  spans.sort((left, right) => left.startMs - right.startMs);

  const trajectory: TrajectoryStep[] = events
    .filter(event => TRAJECTORY_TYPES.has(event.type))
    .map((event, index) => ({ order: index + 1, offsetMs: at(event), title: event.title, detail: event.message }));

  return { taskId: details.task.id, status: details.task.status, totalMs: lastMs, spans, trajectory };
}
