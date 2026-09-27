export type Source = { id: string; name: string; kind: 'file' | 'link'; url?: string; status?: 'queued' | 'collecting' | 'ready' | 'error' }
export type WorkflowStage = 'planning' | 'collecting' | 'analyzing' | 'writing' | 'review' | 'completed'
export type TaskState = WorkflowStage | 'paused' | 'failed'
export type TaskMessage = { id: string; kind: 'revision' | 'followup' | 'system'; text: string; scope?: string; createdAt: number }
export type Task = { id: string; title: string; request: string; sources: Source[]; messages: TaskMessage[]; stage: WorkflowStage; state: TaskState; document: string; documentType: 'md' | 'docx' | 'pdf'; createdAt: number; updatedAt: number; error?: string }
export const stageMeta: Record<WorkflowStage, { label: string; detail: string }> = {
  planning: { label: '요청 정리', detail: '작업 목표와 필요한 결과를 정리하고 있어요.' },
  collecting: { label: '자료 수집', detail: '첨부한 파일과 웹 자료를 확인하고 있어요.' },
  analyzing: { label: '자료 분석', detail: '자료를 비교하고 문서에 필요한 맥락을 만들고 있어요.' },
  writing: { label: '문서 작성', detail: '정리한 내용을 읽기 쉬운 문서로 구성하고 있어요.' },
  review: { label: '결과 확인', detail: '초안을 확인하고 수정할 수 있어요.' },
  completed: { label: '완료', detail: '문서가 준비되었습니다.' }
}
export const stageOrder: WorkflowStage[] = ['planning', 'collecting', 'analyzing', 'writing', 'review']
export function makeDraft(task: Pick<Task, 'title' | 'request' | 'sources'>) {
  const sourceLines = task.sources.length ? task.sources.map((source) => `- ${source.name}`).join('\n') : '- 아직 첨부된 자료가 없습니다.'
  return `# ${task.title}\n\n> 자료 기반으로 생성된 문서 초안입니다.\n\n## 요청 내용\n${task.request}\n\n## 핵심 내용\n수집한 자료를 바탕으로 핵심 내용을 정리합니다.\n\n## 실행 방안\n- 목적과 기대 결과를 명확히 합니다.\n- 필요한 작업과 일정을 정리합니다.\n\n## 참고 자료\n${sourceLines}`
}
