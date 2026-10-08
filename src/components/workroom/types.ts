// Workroom 전체가 공유하는 작업·자료·진행 단계 타입과 문서 초안 생성 규칙을 정의한다.
export type Source = {
  id: string
  name: string
  kind: 'file' | 'link'
  fileId?: string
  file?: File
  url?: string
  status?: 'queued' | 'collecting' | 'ready' | 'error'
}
export type WorkflowStage =
  | 'planning'
  | 'collecting'
  | 'analyzing'
  | 'writing'
  | 'review'
  | 'completed'
export type TaskState =
  | WorkflowStage
  | 'queued'
  | 'running'
  | 'paused'
  | 'failed'
  | 'cancelled'
export type TaskMessage = {
  id: string
  kind: 'revision' | 'followup' | 'system'
  text: string
  scope?: string
  changeSummary?: {
    location: string
    changes: string[]
    method: string
  }
  createdAt: number
}
export type TaskStep = {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  error?: string
}
export type TaskProgressEvent = {
  id: number
  title: string
  detail: string
  items: string[]
  createdAt: number
}
export type LegalAnswerView = {
  intent: string
  path: 'direct' | 'orchestrated'
  answer: string
  citations: import('@/api/workroom').LegalCitation[]
  sourceStatus: import('@/api/workroom').LegalSourceStatus
  plannerCalls: number
  toolCalls: number
  artifactId?: string
  fileId?: string
}
export type LegalLayerState =
  | 'used'
  | 'ready'
  | 'degraded'
  | 'unused'
  | 'unavailable'
export type Task = {
  id: string
  title: string
  request: string
  sources: Source[]
  messages: TaskMessage[]
  revisionBaseline?: { document: string; request: string }
  steps: TaskStep[]
  progressEvents?: TaskProgressEvent[]
  stage: WorkflowStage
  state: TaskState
  document: string
  documentType: 'md' | 'docx' | 'pdf'
  createdAt: number
  updatedAt: number
  error?: string
  savedDocument?: string
  artifactFileId?: string
  artifactName?: string
  artifactMimeType?: string
  sourceFileIds?: string[]
  documentDirty?: boolean
  legal?: LegalAnswerView
}
export const stageMeta: Record<
  WorkflowStage,
  { label: string; detail: string }
> = {
  planning: {
    label: '요청 정리',
    detail: '작업 목표와 필요한 결과를 정리하고 있어요.'
  },
  collecting: {
    label: '자료 수집',
    detail: '첨부한 파일과 웹 자료를 확인하고 있어요.'
  },
  analyzing: {
    label: '자료 분석',
    detail: '자료를 비교하고 문서에 필요한 맥락을 만들고 있어요.'
  },
  writing: {
    label: '문서 작성',
    detail: '정리한 내용을 읽기 쉬운 문서로 구성하고 있어요.'
  },
  review: { label: '결과 확인', detail: '초안을 확인하고 수정할 수 있어요.' },
  completed: { label: '완료', detail: '문서가 준비되었습니다.' }
}
export const stageOrder: WorkflowStage[] = [
  'planning',
  'collecting',
  'analyzing',
  'writing',
  'review'
]

export const legalIntentLabels: Record<string, string> = {
  'article-lookup': '조문 확인',
  'case-lookup': '사건번호 조회',
  'precedent-question': '판례 조사',
  'legal-question': '법률 답변',
  'legal-draft': '법률 문서 초안',
  'legal-research': '복합 법률 조사',
  'non-legal': '문서 작업'
}

export const legalPathLabels: Record<string, string> = {
  direct: '직접 조회',
  orchestrated: '복합 조사'
}
