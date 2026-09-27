import { ExternalLink, FileText, Link2 } from 'lucide-react'
import type { Source, Task } from './types'
export function DocumentPreview({ text }: { text: string }) {
  return <article className="document-text">{text.split('\n').map((line, index) => {
    if (line.startsWith('# ')) return <h2 key={index}>{line.slice(2)}</h2>
    if (line.startsWith('## ')) return <h3 key={index}>{line.slice(3)}</h3>
    if (line.startsWith('> ')) return <blockquote key={index}>{line.slice(2)}</blockquote>
    if (line.startsWith('- ')) return <li key={index}>{line.slice(2)}</li>
    return <p key={index}>{line || '\u00a0'}</p>
  })}</article>
}
function sourceStatus(source: Source) {
  if (source.status === 'collecting') return '자료를 읽고 있어요.'
  if (source.status === 'ready') return '분석 준비 완료'
  if (source.status === 'error') return '자료를 읽지 못했습니다.'
  return source.kind === 'link' ? '웹 자료 · 대기 중' : '첨부 파일 · 대기 중'
}
export function Sources({ sources }: { sources: Source[] }) {
  return <div className="source-list">{sources.length ? sources.map((source, index) => <div className="source" key={source.id}>
    <span className="source-number">{String(index + 1).padStart(2, '0')}</span>
    <div className="source-content"><div className="source-title">{source.kind === 'link' ? <Link2 size={14} /> : <FileText size={14} />}{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}<ExternalLink size={12} /></a> : <strong>{source.name}</strong>}</div><small>{sourceStatus(source)}</small></div>
  </div>) : <p className="muted">아직 추가된 자료가 없습니다.</p>}<p className="fine-print">사용한 파일과 웹 자료는 문서의 근거로 표시됩니다.</p></div>
}
export async function downloadDocument(task: Task, format: 'md' | 'docx') {
  let blob: Blob
  if (format === 'md') blob = new Blob([task.document], { type: 'text/markdown;charset=utf-8' })
  else {
    const { Document, Packer, Paragraph, HeadingLevel } = await import('docx')
    const children = task.document.split('\n').map((line) => new Paragraph({ text: line.replace(/^#{1,2} |^> |^- /, ''), ...(line.startsWith('# ') ? { heading: HeadingLevel.HEADING_1 } : {}), ...(line.startsWith('## ') ? { heading: HeadingLevel.HEADING_2 } : {}) }))
    blob = await Packer.toBlob(new Document({ sections: [{ children }] }))
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${task.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '문서'}.${format}`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
