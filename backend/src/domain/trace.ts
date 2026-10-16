/**
 * A trace is a timeline of one task's run. Every time is an offset in milliseconds from the moment the task was created,
 * so a trace can be drawn without knowing the clock of the machine that ran it.
 */
export type TraceSpanKind = 'step' | 'llm' | 'error';

/** The part of the work a step belongs to; the same four parts the processing flow shows. */
export type TraceStage = 'classify' | 'retrieve' | 'answer' | 'verify';

export type TraceSpan = {
  kind: TraceSpanKind;
  name: string;
  startMs: number;
  durationMs: number;
  /** 'cancelled' marks a step that was still open when the person cancelled the task. */
  status: 'ok' | 'error' | 'running' | 'cancelled';
  /** Model name for llm spans; the failure text for error spans; the reason for a reused step. */
  detail?: string;
  /** Set on step spans when the step's stage is known. */
  stage?: TraceStage;
  promptTokens?: number;
  completionTokens?: number;
  /** True when the start of an llm span is inferred from its duration because the start time was not recorded. */
  estimated?: boolean;
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
