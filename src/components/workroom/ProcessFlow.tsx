import React, { useState } from 'react'
import {
  getTaskTrace,
  type Connection,
  type TaskTrace
} from '../../api/workroom'
import ActivityLog from './ActivityLog'
import { buildProcessFlow, type FlowStage } from './processFlowModel'
import type { Task } from './types'

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}초`
}

type TraceState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; trace: TaskTrace }
  | { phase: 'error'; message: string }

/**
 * One processing flow for a task: what each stage decided, the search tools and models it used, and how long it took.
 * The run trace is fetched the first time the flow is opened, so a closed panel costs no request. The raw event log
 * stays folded at the bottom.
 */
export default function ProcessFlow({
  task,
  connection
}: {
  task: Task
  connection?: Connection
}) {
  const [trace, setTrace] = useState<TraceState>({ phase: 'idle' })

  function onToggle(open: boolean) {
    if (
      !open ||
      !connection ||
      trace.phase === 'loading' ||
      trace.phase === 'ready'
    )
      return
    setTrace({ phase: 'loading' })
    getTaskTrace(task.id, connection)
      .then((loaded) => setTrace({ phase: 'ready', trace: loaded }))
      .catch((error: unknown) =>
        setTrace({
          phase: 'error',
          message:
            error instanceof Error
              ? error.message
              : '처리 시간을 불러오지 못했습니다.'
        })
      )
  }

  const stages: FlowStage[] = buildProcessFlow({
    legal: task.legal,
    modelUse: task.modelUse,
    trace: trace.phase === 'ready' ? trace.trace : undefined
  })
  const hasActivity = Boolean(task.activity && task.activity.length > 0)

  return (
    <details
      className="process-flow"
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>처리 흐름</summary>
      {trace.phase === 'loading' ? (
        <p className="process-flow__note">처리 시간을 불러오는 중…</p>
      ) : null}
      {trace.phase === 'error' ? (
        <p
          className="process-flow__note process-flow__note--error"
          role="alert"
        >
          {trace.message}
        </p>
      ) : null}
      {stages.length > 0 ? (
        <ol className="process-flow__stages" aria-label="처리 단계">
          {stages.map((stage) => (
            <li
              key={stage.key}
              className={`process-flow__stage process-flow__stage--${stage.status}`}
            >
              <div className="process-flow__head">
                <strong>{stage.label}</strong>
                {stage.durationMs !== undefined ? (
                  <time>{seconds(stage.durationMs)}</time>
                ) : null}
              </div>
              <p>{stage.summary}</p>
              {stage.details.length > 0 ? (
                <ul>
                  {stage.details.map((line, index) => (
                    <li key={`${line}-${index}`}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="process-flow__note">아직 기록된 처리 단계가 없습니다.</p>
      )}
      {hasActivity ? (
        <details className="process-flow__raw">
          <summary>원본 기록 {task.activity!.length}건</summary>
          <ActivityLog activity={task.activity!} />
        </details>
      ) : null}
    </details>
  )
}
