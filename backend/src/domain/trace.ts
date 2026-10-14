/**
 * A trace is a timeline of one task's run. Every time is an offset in milliseconds from the moment the task was created,
 * so a trace can be drawn without knowing the clock of the machine that ran it.
 */
export type TraceSpanKind = 'step' | 'llm' | 'error';

export type TraceSpan = {
  kind: TraceSpanKind;
  name: string;
  startMs: number;
  durationMs: number;
  status: 'ok' | 'error' | 'running';
  /** Model name for llm spans; the failure text for error spans. */
  detail?: string;
  promptTokens?: number;
  completionTokens?: number;
};

/** One decision or stage change, in the order the task made it. */
export type TrajectoryStep = {
  order: number;
  offsetMs: number;
  title: string;
  detail: string;
};

export type TaskTrace = {
  taskId: string;
  status: string;
  totalMs: number;
  spans: TraceSpan[];
  trajectory: TrajectoryStep[];
};
