import React, { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronDown,
  FileText,
  LoaderCircle,
  X
} from 'lucide-react'
import Composer from './Composer'
import ModelUsage from './ModelUsage'
import ProcessFlow from './ProcessFlow'
import type { Connection } from '../../api/workroom'
import { safeHttpUrl } from './safe-http-url'
import { RouteChips } from './EvidenceChain'
import { Sources } from './Documents'
import {
  legalIntentLabels,
  legalPathLabels,
  stageMeta,
  stageOrder
} from './types'
import type {
  Source,
  SourceUploadProgress,
  Task,
  TaskState,
  WorkflowStage
} from './types'

export type TaskContextPanelProps = {
  task: Task
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
  backendKey?: string
  /** Needed to fetch the run's trace; the panel never reads the token itself. */
  connection?: Connection
  canceling?: boolean
  onCancel: () => void
  onFollowup: (
    request: string,
    kind?: 'revision' | 'followup',
    sources?: Source[],
    onUploadProgress?: (progress: SourceUploadProgress) => void
  ) => Promise<boolean>
  onDraftFromAnswer?: () => void
}

const stateLabels: Partial<Record<TaskState, string>> = {
  queued: '대기 중',
  running: '진행 중',
  paused: '일시정지',
  failed: '실패',
  cancelled: '취소됨'
}

function taskStateLabel(state: TaskState): string {
  return stateLabels[state] ?? stageMeta[state as WorkflowStage].label
}

function statusMessage(task: Task): string {
  switch (task.state) {
    case 'queued':
      return '백엔드 작업 대기열에 등록되어 있습니다.'
    case 'running': {
      const latest = task.activity?.filter((item) => item.detail).at(-1)
      if (latest) return latest.detail
      const active = task.steps.find((step) => step.status === 'running')
      return active
        ? `${active.title} 단계에서 진행 중입니다.`
        : stageMeta[task.stage].detail
    }
    case 'paused':
      return '작업이 일시정지되었습니다.'
    case 'failed':
      return task.error || '작업이 실패했습니다.'
    case 'cancelled':
      return '작업이 취소되었습니다.'
    case 'completed':
      return '작업이 완료되었습니다.'
    default:
      return stageMeta[task.state].detail
  }
}

function isTerminal(state: TaskState): boolean {
  return ['completed', 'failed', 'cancelled', 'paused'].includes(state)
}

const CORPUS_LABELS: Record<string, string> = {
  law: '법령·조문',
  precedent: '판례',
  graph: '관계 그래프',
  document: '첨부 자료',
  web: '웹 자료'
}

function formatTokenCount(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('ko-KR').format(value)
    : '—'
}

function formatDuration(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value < 60_000) return `${(value / 1000).toFixed(1)}초`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.floor((value % 60_000) / 1000)
  return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`
}

function UsageMetrics({
  task,
  timeline
}: {
  task: Task
  timeline: Array<{ key: string; title: string }>
}) {
  const usageByStep = new Map(
    (task.usageMetrics?.stages ?? []).map((stage) => [stage.stepId, stage])
  )
  const stageMetrics = timeline.map((step) => usageByStep.get(step.key))
  const hasCompleteStageTotals =
    stageMetrics.length > 0 &&
    stageMetrics.every((stage) => typeof stage?.tokenCount === 'number')
  const hasCompleteStageDurations =
    stageMetrics.length > 0 &&
    stageMetrics.every((stage) => typeof stage?.durationMs === 'number')
  const totalTokenCount =
    task.usageMetrics?.totalTokenCount ??
    (hasCompleteStageTotals
      ? stageMetrics.reduce(
          (total, stage) => total + (stage?.tokenCount ?? 0),
          0
        )
      : undefined)
  const totalDurationMs =
    task.usageMetrics?.totalDurationMs ??
    (hasCompleteStageDurations
      ? stageMetrics.reduce(
          (total, stage) => total + (stage?.durationMs ?? 0),
          0
        )
      : undefined)
  const hasStageData = stageMetrics.some(
    (stage) =>
      stage?.tokenCount !== undefined || stage?.durationMs !== undefined
  )
  const hasUsageData =
    totalTokenCount !== undefined ||
    totalDurationMs !== undefined ||
    stageMetrics.some(
      (stage) =>
        stage?.tokenCount !== undefined || stage?.durationMs !== undefined
    )

  return (
    <section
      className="task-context__section task-context__usage"
      aria-labelledby="task-usage-title"
    >
      <details className="task-context__usage-details">
        <summary>
          <span id="task-usage-title">단계별 토큰·시간</span>
          <span className="task-context__usage-summary">
            {hasUsageData
              ? `${formatTokenCount(totalTokenCount)} 토큰 · ${formatDuration(totalDurationMs)}`
              : '계측 연동 대기'}
          </span>
          <ChevronDown
            className="task-context__usage-chevron"
            aria-hidden="true"
            size={15}
          />
        </summary>
        <div className="task-context__usage-content">
          {!hasUsageData ? (
            <p className="task-context__usage-note">
              백엔드 계측값이 연결되면 단계별 토큰과 소요 시간을 표시합니다.
            </p>
          ) : null}
          {hasUsageData && !hasStageData ? (
            <p className="task-context__usage-note">
              이 작업의 모델 호출 전체 합계입니다. 단계별 수치는 백엔드가
              단계별로 기록하면 표시됩니다.
            </p>
          ) : null}
          {hasStageData || !hasUsageData ? (
            <table className="task-context__usage-table">
              <thead>
                <tr>
                  <th scope="col">단계</th>
                  <th scope="col">토큰</th>
                  <th scope="col">소요 시간</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((step) => {
                  const usage = usageByStep.get(step.key)
                  return (
                    <tr key={step.key}>
                      <th scope="row">{step.title}</th>
                      <td>{formatTokenCount(usage?.tokenCount)}</td>
                      <td>{formatDuration(usage?.durationMs)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">합계</th>
                  <td>{formatTokenCount(totalTokenCount)}</td>
                  <td>{formatDuration(totalDurationMs)}</td>
                </tr>
              </tfoot>
            </table>
          ) : null}
        </div>
      </details>
    </section>
  )
}

function LegalAnswer({
  task,
  onDraftFromAnswer
}: {
  task: Task
  onDraftFromAnswer?: () => void
}) {
  const legal = task.legal
  if (!legal) return null
  return (
    <section
      className="task-context__section task-context__legal"
      aria-labelledby="task-legal-title"
    >
      <div className="task-context__section-heading">
        <h3 id="task-legal-title">법률 답변</h3>
        <span>{legalIntentLabels[legal.intent] ?? '법률 답변'}</span>
      </div>
      <p className="task-context__legal-path">
        {legalPathLabels[legal.path]} · 검색 근거 {legal.sourceStatus.retrieved}
        건 · 본문 인용 {legal.sourceStatus.cited ?? 0}건 ·{' '}
        {legal.sourceStatus.currentness === 'record-dated'
          ? '기록에 포함된 날짜 표기로만 확인'
          : '색인이 현행 여부를 확인하지 않음'}
      </p>
      <ModelUsage totals={task.modelUse?.totals} />
      <p className="task-context__legal-note">
        일반인을 위한 법률 정보이며 법률 자문이나 대리인이 아닙니다. 중요한 결정
        전에는 전문가 상담으로 확인하세요.
      </p>
      {legal.citations.length > 0 ? (
        <>
          <h4 className="task-context__legal-subheading">인용 근거</h4>
          <ol className="task-context__citations">
            {legal.citations.map((citation) => (
              <li key={citation.citationId}>
                <span className="task-context__citation-id">
                  [{citation.citationId}]
                </span>
                <span className="task-context__citation-body">
                  <strong>
                    {safeHttpUrl(citation.officialUrl) ? (
                      <a
                        href={safeHttpUrl(citation.officialUrl)}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {citation.label}
                      </a>
                    ) : (
                      citation.label
                    )}
                  </strong>
                  <small>
                    {CORPUS_LABELS[citation.corpus] ?? citation.corpus}
                    {citation.date
                      ? ` · ${
                          citation.date.kind === 'amendment'
                            ? '개정 표기'
                            : '선고'
                        } ${citation.date.value}`
                      : ''}
                  </small>
                  <RouteChips provenance={citation.provenance} />
                </span>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="task-context__legal-note task-context__legal-note--warning">
          확인된 법령·판례 기록이 없어 단정적인 법적 결론을 제시하지 않습니다.
        </p>
      )}
      {legal.sourceStatus.notes.length > 0 ? (
        <ul className="task-context__legal-notes">
          {legal.sourceStatus.notes.map((note, index) => (
            <li key={`${index}-${note}`}>{note}</li>
          ))}
        </ul>
      ) : null}
      {onDraftFromAnswer && task.state === 'completed' ? (
        <button
          className="task-context__action"
          type="button"
          onClick={onDraftFromAnswer}
        >
          <FileText aria-hidden="true" size={14} />
          <span>답변을 법률 문서 초안으로 정리</span>
        </button>
      ) : null}
    </section>
  )
}

export default function TaskContextPanel({
  task,
  mobileOpen,
  onMobileOpenChange,
  backendKey = '',
  connection,
  canceling = false,
  onCancel,
  onFollowup,
  onDraftFromAnswer
}: TaskContextPanelProps) {
  const [requestKind, setRequestKind] = useState<'revision' | 'followup'>(
    'followup'
  )
  const currentIndex = stageOrder.indexOf(task.stage)
  const activeStage = !isTerminal(task.state) && task.state !== 'queued'
  const closeButton = useRef<HTMLButtonElement>(null)
  const timeline =
    task.steps.length > 0
      ? task.steps.map((step) => ({
          key: step.id,
          title: step.title,
          done:
            step.status === 'completed' ||
            task.state === 'completed' ||
            task.state === 'cancelled',
          current: step.status === 'running',
          detail: step.error
        }))
      : stageOrder.map((stage, index) => ({
          key: stage,
          title: stageMeta[stage].label,
          done: task.state === 'completed' || index < currentIndex,
          current:
            !isTerminal(task.state) && index === currentIndex && activeStage,
          detail: stageMeta[stage].detail
        }))
  const currentStep = timeline.find((step) => step.current)
  const completedSteps = timeline.filter((step) => step.done).length
  const progressSummary =
    task.state === 'completed'
      ? `${timeline.length}단계 완료`
      : task.state === 'running'
        ? `진행 중 · ${currentStep?.title ?? '작업 중'}`
        : task.state === 'queued'
          ? '시작 대기 중'
          : `${taskStateLabel(task.state)} · ${completedSteps}/${timeline.length}`

  useEffect(() => setRequestKind('followup'), [task.id])
  useEffect(() => {
    if (!mobileOpen) return
    const previous = document.activeElement
    closeButton.current?.focus()
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onMobileOpenChange(false)
      }
    }
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('keydown', dismiss)
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus()
    }
  }, [mobileOpen, onMobileOpenChange])

  return (
    <aside
      className={`task-context ${mobileOpen ? 'task-context--mobile-open' : ''}`}
      aria-label="작업 컨텍스트"
    >
      <button
        ref={closeButton}
        className="task-context__mobile-close"
        type="button"
        aria-label="작업 정보 닫기"
        onClick={() => onMobileOpenChange(false)}
      >
        <X aria-hidden="true" size={18} />
      </button>

      <div
        className="task-context__scroll"
        role="region"
        aria-label="작업 정보"
        tabIndex={0}
      >
        <section
          className="task-context__section"
          aria-labelledby="task-request-title"
        >
          <h3 id="task-request-title">요청 내용</h3>
          <div
            className="task-context__message task-context__message--user"
            aria-label="사용자 메시지"
          >
            <p className="task-context__request">{task.request}</p>
          </div>
        </section>

        <div className="task-context__header">
          <div>
            <span className="task-context__eyebrow">작업</span>
            <h2>{task.title}</h2>
          </div>
          <span
            className={`task-context__state task-context__state--${task.state}`}
          >
            {taskStateLabel(task.state)}
          </span>
        </div>

        <section
          className="task-context__section"
          aria-labelledby="task-sources-title"
        >
          <div className="task-context__section-heading">
            <h3 id="task-sources-title">참고 자료</h3>
            <span>{task.sources.length}</span>
          </div>
          <Sources sources={task.sources} />
        </section>

        <section
          className="task-context__section"
          aria-labelledby="task-progress-title"
        >
          <div className="task-context__section-heading">
            <details className="task-context__progress-details">
              <summary aria-labelledby="task-progress-title">
                <span id="task-progress-title">작업 진행 상황</span>
                <span className="task-context__progress-summary">
                  {progressSummary}
                </span>
                <ChevronDown
                  className="task-context__progress-chevron"
                  aria-hidden="true"
                  size={15}
                />
              </summary>
              <div className="task-context__progress-content">
                <ol className="task-context__timeline">
                  {timeline.map((step) => (
                    <li
                      className={`task-context__step ${step.done ? 'is-done' : ''} ${step.current ? 'is-current' : ''}`}
                      key={step.key}
                    >
                      <span
                        className="task-context__step-mark"
                        aria-hidden="true"
                      >
                        {step.done ? (
                          <Check size={14} />
                        ) : step.current ? (
                          <LoaderCircle size={14} className="is-spinning" />
                        ) : (
                          <span />
                        )}
                      </span>
                      <div>
                        <strong>{step.title}</strong>
                        {step.current || step.detail ? (
                          <p>{step.detail ?? stageMeta[task.stage].detail}</p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
                <p
                  className={`task-context__status ${task.state === 'failed' ? 'task-context__status--error' : ''}`}
                  role={task.state === 'failed' ? 'alert' : 'status'}
                >
                  {task.state === 'failed' ? (
                    <AlertCircle aria-hidden="true" size={15} />
                  ) : null}
                  {statusMessage(task)}
                </p>
              </div>
            </details>
            {['queued', 'running'].includes(task.state) ? (
              <button
                className="task-context__action"
                type="button"
                disabled={canceling}
                aria-busy={canceling}
                onClick={onCancel}
              >
                <X aria-hidden="true" size={14} />
                <span>작업 취소</span>
              </button>
            ) : null}
          </div>
        </section>

        <UsageMetrics task={task} timeline={timeline} />

        {task.messages
          .filter((message) => message.kind !== 'system')
          .map((message) => (
            <article
              className="task-context__message task-context__message--user"
              aria-label="사용자 메시지"
              key={message.id}
            >
              <span className="task-context__message-label">
                {message.kind === 'revision' ? '수정 요청' : '추가 요청'}
              </span>
              <p>{message.text}</p>
              {message.changeSummary ? (
                <div
                  className="task-context__change-summary"
                  aria-label="추가 요청 반영 요약"
                >
                  <strong>반영 요약</strong>
                  <p>
                    <b>위치</b> {message.changeSummary.location}
                  </p>
                  <p>
                    <b>변경</b> {message.changeSummary.changes.join(' · ')}
                  </p>
                  <p>
                    <b>방식</b> {message.changeSummary.method}
                  </p>
                </div>
              ) : null}
            </article>
          ))}

        <LegalAnswer task={task} onDraftFromAnswer={onDraftFromAnswer} />
        {task.legal ||
        task.modelUse ||
        (task.activity && task.activity.length > 0) ? (
          <ProcessFlow task={task} connection={connection} />
        ) : null}
      </div>

      <div className="task-context__composer">
        <div
          className="task-context__request-kind"
          role="group"
          aria-label="요청 유형"
        >
          <button
            type="button"
            aria-pressed={requestKind === 'followup'}
            onClick={() => setRequestKind('followup')}
          >
            추가 요청
          </button>
          <button
            type="button"
            aria-pressed={requestKind === 'revision'}
            onClick={() => setRequestKind('revision')}
          >
            문서 수정
          </button>
        </div>
        <Composer
          key={task.id}
          compact
          draftKey={`${backendKey}:${task.id}`}
          placeholder={
            requestKind === 'revision'
              ? '문서에서 바꿀 내용을 적어 주세요.'
              : undefined
          }
          disabled={['queued', 'running'].includes(task.state)}
          onSubmit={(request, sources, _workflow, onUploadProgress) =>
            onFollowup(request, requestKind, sources, onUploadProgress)
          }
        />
      </div>
    </aside>
  )
}
