export type Source = { name: string; url?: string }
export type Task = {
  id: string
  title: string
  request: string
  sources: Source[]
  messages: { text: string; kind: 'revision' | 'followup'; scope?: string }[]
  stage: number
  state: 'running' | 'paused' | 'complete'
  document: string
  created: number
}
export const stateNames = {
  running: '진행 중',
  paused: '일시정지',
  complete: '완료'
}
export function makeDraft(task: Task) {
  return `# ${task.title}\n\n> 화면 데모용 문서 틀입니다. AI가 조사·작성한 결과가 아닙니다.\n\n## 요청사항\n${task.request}\n\n## 핵심 내용\n여기에 조사한 내용과 결론을 작성하세요.\n\n## 실행 방안\n- 해야 할 일\n- 담당자와 일정\n\n## 확인할 자료\n${task.sources.length ? task.sources.map((s) => `- ${s.name} (내용 미확인)`).join('\n') : '아직 첨부한 자료가 없습니다.'}`
}
