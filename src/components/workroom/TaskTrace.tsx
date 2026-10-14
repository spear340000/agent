import React, { useState } from 'react'
import {
  getTaskTrace,
  type Connection,
  type TaskTrace as TraceData,
  type TaskTraceSpan
} from '../../api/workroom'

const KIND_LABEL: Record<TaskTraceSpan['kind'], string> = {
  step: '단계',
  llm: '모델',
  error: '오류'
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}초`
}

/** Token counts read more easily with thousands separators, e.g. 3,381. */
export function tokens(count: number): string {
  return count.toLocaleString('en-US')
}

/**
 * Places each span on a timeline of the whole run. Left and width are percentages of the total; a span that lasts no
 * time gets a minimum width so a failure still shows as a mark.
 */
export function traceBars(
  trace: TraceData
): Array<{ span: TaskTraceSpan; left: number; width: number }> {
  const total = Math.max(trace.totalMs, 1)
  return trace.spans.map((span) => ({
    span,
    left: Math.min(100, (span.startMs / total) * 100),
    width: Math.max(1, Math.min(100, (span.durationMs / total) * 100))
  }))
}

type TraceState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; trace: TraceData }
  | { phase: 'error'; message: string }

/** Loads the run's trace the first time it is opened, so a closed panel costs no request. */
export default function TaskTrace({
  taskId,
  connection
}: {
  taskId: string
  connection: Connection
}) {
  const [state, setState] = useState<TraceState>({ phase: 'idle' })

  function onToggle(open: boolean) {
    if (!open || state.phase === 'loading' || state.phase === 'ready') return
    setState({ phase: 'loading' })
    getTaskTrace(taskId, connection)
      .then((trace) => setState({ phase: 'ready', trace }))
      .catch((error: unknown) =>
        setState({
          phase: 'error',
          message:
            error instanceof Error
              ? error.message
              : '추적 정보를 불러오지 못했습니다.'
        })
      )
  }

  return (
    <details
      className="task-trace"
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>실행 추적 (타임라인 · 판단 순서)</summary>
      {state.phase === 'loading' ? (
        <p className="task-trace__note">불러오는 중…</p>
      ) : null}
      {state.phase === 'error' ? (
        <p className="task-trace__note task-trace__note--error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.phase === 'ready' ? <TraceView trace={state.trace} /> : null}
    </details>
  )
}

function TraceView({ trace }: { trace: TraceData }) {
  if (trace.spans.length === 0 && trace.trajectory.length === 0) {
    return <p className="task-trace__note">아직 기록된 단계가 없습니다.</p>
  }
  return (
    <div className="task-trace__body">
      <ol className="task-trace__timeline" aria-label="실행 타임라인">
        {traceBars(trace).map(({ span, left, width }, index) => (
          <li
            key={`${span.kind}-${index}`}
            className={`task-trace__row task-trace__row--${span.status}`}
          >
            <span className="task-trace__label">
              <span className="task-trace__kind">{KIND_LABEL[span.kind]}</span>
              {span.name}
              <time>{seconds(span.durationMs)}</time>
            </span>
            <span className="task-trace__track" aria-hidden="true">
              <span
                className="task-trace__bar"
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </span>
            {span.detail ? (
              <span className="task-trace__detail">{span.detail}</span>
            ) : null}
            {span.completionTokens !== undefined ? (
              <span className="task-trace__detail">
                입력 {tokens(span.promptTokens ?? 0)} / 출력{' '}
                {tokens(span.completionTokens)} 토큰
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {trace.trajectory.length > 0 ? (
        <ol className="task-trace__trajectory" aria-label="판단 순서">
          {trace.trajectory.map((step) => (
            <li key={step.order}>
              <time>{seconds(step.offsetMs)}</time>
              <strong>{step.title}</strong>
              {step.detail ? <span>{step.detail}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
