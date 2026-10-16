import React, { useState } from 'react'
import type { Connection } from '../../api/workroom'
import ActivityLog from './ActivityLog'
import { buildProcessFlow, type FlowStage } from './processFlowModel'
import { seconds } from './traceFormat'
import { useTaskTrace } from './useTaskTrace'
import type { Task } from './types'

const STATUS_LABEL: Record<FlowStage['status'], string> = {
  done: '',
  error: '오류',
  running: '진행 중',
  cancelled: '취소됨'
}

/**
 * One processing flow for a task: what each stage decided, the search tools and models it used, how long it took, and
 * the order of decisions. The run trace is read only once the flow is opened, and again every few seconds while the
 * task is still running. The raw event log stays folded at the bottom.
 */
export default function ProcessFlow({
  task,
  connection
}: {
  task: Task
  connection?: Connection
}) {
  const [opened, setOpened] = useState(false)
  const trace = useTaskTrace(task.id, connection, {
    enabled: opened,
    live: task.state === 'queued' || task.state === 'running'
  })

  const stages: FlowStage[] = buildProcessFlow({
    legal: task.legal,
    modelUse: task.modelUse,
    trace: trace.trace
  })
  const hasActivity = Boolean(task.activity && task.activity.length > 0)
  const trajectory = trace.trace?.trajectory ?? []

  return (
    <details
      className="process-flow"
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>처리 흐름</summary>
      {trace.phase === 'loading' && !trace.trace ? (
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
                {STATUS_LABEL[stage.status] ? (
                  <span className="process-flow__badge">
                    {STATUS_LABEL[stage.status]}
                  </span>
                ) : null}
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
      {trajectory.length > 0 ? (
        <details className="process-flow__trajectory">
          <summary>판단 순서 {trajectory.length}건</summary>
          <ol aria-label="판단 순서">
            {trajectory.map((step) => (
              <li key={step.order}>
                <time>{seconds(step.offsetMs)}</time>
                <strong>{step.title}</strong>
                {step.detail ? <span>{step.detail}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {hasActivity ? (
        <details className="process-flow__raw">
          <summary>원본 기록 {task.activity!.length}건</summary>
          <ActivityLog activity={task.activity!} />
        </details>
      ) : null}
    </details>
  )
}
