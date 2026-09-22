import type { Source, Task } from './types'

export function DocumentPreview({ text }: { text: string }) {
  return (
    <article className="document-text">
      {text.split('\n').map((line, i) => {
        if (line.startsWith('# ')) return <h2 key={i}>{line.slice(2)}</h2>
        if (line.startsWith('## ')) return <h3 key={i}>{line.slice(3)}</h3>
        if (line.startsWith('> '))
          return <blockquote key={i}>{line.slice(2)}</blockquote>
        return <p key={i}>{line || '\u00a0'}</p>
      })}
    </article>
  )
}
export function Sources({ sources }: { sources: Source[] }) {
  return (
    <div className="source-list">
      {sources.length ? (
        sources.map((s, i) => (
          <div className="source" key={i}>
            <span className="source-number">{i + 1}</span>
            <div>
              {s.url && /^https?:\/\//i.test(s.url) ? (
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.name}
                </a>
              ) : (
                <strong>{s.name}</strong>
              )}
              <small>
                {s.url ? '입력한 링크 · 수집 전' : '선택한 파일 · 업로드 전'}
              </small>
            </div>
          </div>
        ))
      ) : (
        <p className="muted">첨부한 자료가 없습니다.</p>
      )}
      <p className="fine-print">
        파일명과 링크만 보관합니다. 파일 업로드·내용 분석·웹 수집은 서버 연결 후
        사용할 수 있습니다.
      </p>
    </div>
  )
}
export async function downloadDocument(task: Task, format: 'md' | 'docx') {
  let blob: Blob
  if (format === 'md')
    blob = new Blob([task.document], { type: 'text/markdown;charset=utf-8' })
  else {
    const { Document, Packer, Paragraph, HeadingLevel } = await import('docx')
    const children = task.document
      .split('\n')
      .map(
        (line) =>
          new Paragraph({
            text: line.replace(/^#{1,2} |^> /, ''),
            ...(line.startsWith('# ')
              ? { heading: HeadingLevel.HEADING_1 }
              : line.startsWith('## ')
                ? { heading: HeadingLevel.HEADING_2 }
                : {})
          })
      )
    blob = await Packer.toBlob(new Document({ sections: [{ children }] }))
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${task.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '문서'}.${format}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
