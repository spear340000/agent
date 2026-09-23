// 백엔드 연결 전 시연을 위해 작업 단계와 문서 생성을 로컬에서 모의 실행한다.
import {
  makeDraft,
  type Source,
  type Task,
  type TaskMessage,
  type WorkflowStage
} from '@/components/workroom/types'
const seedSources: Source[] = [
  { id: 'source-1', name: '기획서.xlsx', kind: 'file', status: 'ready' },
  { id: 'source-2', name: '제품 요구사항 문서', kind: 'file', status: 'ready' }
]
function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
const demoDelay: Record<WorkflowStage, number> = {
  planning: 120,
  collecting: 320,
  analyzing: 360,
  writing: 420,
  review: 280,
  completed: 180
}
export function createMockTask(request: string, sources: Source[]): Task {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title: request.slice(0, 42),
    request,
    sources,
    messages: [],
    stage: 'planning',
    state: 'planning',
    document: '',
    documentType: 'md',
    createdAt: now,
    updatedAt: now
  }
}
export async function runMockTask(task: Task, onUpdate: (task: Task) => void) {
  const stages: WorkflowStage[] = [
    'planning',
    'collecting',
    'analyzing',
    'writing',
    'review'
  ]
  let next = { ...task }
  for (const stage of stages) {
    await wait(demoDelay[stage])
    next = { ...next, stage, state: stage, updatedAt: Date.now() }
    if (stage === 'collecting')
      next.sources = next.sources.map((source) => ({
        ...source,
        status: 'collecting'
      }))
    if (stage === 'analyzing')
      next.sources = next.sources.map((source) => ({
        ...source,
        status: 'ready'
      }))
    if (stage === 'writing') next.document = makeDraft(next)
    onUpdate(next)
  }
  await wait(demoDelay.completed)
  onUpdate({
    ...next,
    stage: 'completed',
    state: 'completed',
    updatedAt: Date.now()
  })
}
export function getExampleTask(): Task {
  const task = createMockTask(
    '자료 기반 AI 문서 작업 도구의 프론트엔드 구현 계획을 정리해 주세요.',
    seedSources
  )
  return {
    ...task,
    title: '자료 기반 AI 문서 작업 도구',
    stage: 'review',
    state: 'review',
    document: makeDraft(task)
  }
}
export async function sendMockMessage(
  task: Task,
  text: string,
  kind: TaskMessage['kind'] = 'followup'
) {
  await wait(350)
  return {
    ...task,
    messages: [
      ...task.messages,
      { id: crypto.randomUUID(), kind, text, createdAt: Date.now() }
    ],
    updatedAt: Date.now()
  }
}
