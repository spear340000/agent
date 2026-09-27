'use client'
// 요청 문장과 파일·링크를 입력받아 하나의 새 작업 또는 추가 요청으로 전달한다.
import { useRef, useState } from 'react'
import { ArrowUp, FilePlus2, Link2, X } from 'lucide-react'
import type { Source } from './types'
const suggestions = [
  [
    '자료 조사',
    '다음 주제에 필요한 자료를 조사하고 보고서 초안으로 정리해 주세요.'
  ],
  ['자료 비교', '첨부한 자료들의 공통점과 차이점을 비교 문서로 정리해 주세요.'],
  ['기획안 작성', '목적, 실행 방안, 일정이 포함된 기획 초안을 작성해 주세요.']
]
export default function Composer({
  onSubmit,
  compact = false
}: {
  onSubmit: (request: string, sources: Source[]) => void
  compact?: boolean
}) {
  const [request, setRequest] = useState('')
  const [sources, setSources] = useState<Source[]>([])
  const [link, setLink] = useState('')
  const [linkOpen, setLinkOpen] = useState(false)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  function addLink() {
    try {
      const url = new URL(link.trim())
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
      setSources((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          name: url.hostname,
          kind: 'link',
          url: url.href,
          status: 'queued'
        }
      ])
      setLink('')
      setLinkOpen(false)
      setError('')
    } catch {
      setError('http:// 또는 https://로 시작하는 주소를 입력해 주세요.')
    }
  }
  return (
    <>
      <form
        className={`composer ${compact ? 'composer-compact' : ''}`}
        onSubmit={(event) => {
          event.preventDefault()
          if (!request.trim()) return
          onSubmit(request.trim(), sources)
          setRequest('')
          setSources([])
        }}
      >
        <textarea
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={
            compact
              ? '추가로 원하는 내용을 입력해 주세요.'
              : '어떤 문서를 만들고 싶은지 설명해 주세요.'
          }
          maxLength={12000}
          aria-label="작업 요청"
        />
        {linkOpen && (
          <div className="link-entry">
            <Link2 size={15} />
            <input
              autoFocus
              value={link}
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addLink()
                }
              }}
              placeholder="https://example.com"
              aria-label="웹 주소"
            />
            <button type="button" onClick={addLink}>
              추가
            </button>
            <button
              type="button"
              onClick={() => setLinkOpen(false)}
              aria-label="링크 입력 닫기"
            >
              <X size={15} />
            </button>
          </div>
        )}
        <div className="composer-footer">
          <div className="composer-actions">
            <button
              type="button"
              className="tool-button"
              onClick={() => fileInput.current?.click()}
            >
              <FilePlus2 size={16} /> 파일 추가
            </button>
            <button
              type="button"
              className="tool-button"
              onClick={() => setLinkOpen(true)}
            >
              <Link2 size={16} /> 링크 추가
            </button>
            {sources.length > 0 && (
              <span className="attachment-count">자료 {sources.length}개</span>
            )}
          </div>
          <button
            className="send-button"
            disabled={!request.trim()}
            aria-label={compact ? '추가 요청 보내기' : '작업 시작'}
          >
            <ArrowUp size={17} />
          </button>
        </div>
        {sources.length > 0 && (
          <div className="attachment-list">
            {sources.map((source, index) => (
              <span className="attachment" key={source.id}>
                <span>{source.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setSources((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index)
                    )
                  }
                  aria-label={`${source.name} 제거`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={fileInput}
          hidden
          type="file"
          multiple
          accept=".pdf,.docx,.pptx,.xlsx"
          onChange={(event) => {
            const selected = Array.from(event.target.files || [])
            const accepted = selected.filter((file) =>
              /\.(pdf|docx|pptx|xlsx)$/i.test(file.name)
            )
            setSources((current) => [
              ...current,
              ...accepted.map((file) => ({
                id: crypto.randomUUID(),
                name: file.name,
                kind: 'file' as const,
                status: 'queued' as const
              }))
            ])
            if (selected.length !== accepted.length)
              setError('PDF, DOCX, PPTX, XLSX 파일만 추가할 수 있습니다.')
            event.target.value = ''
          }}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
      {!compact && (
        <div className="shortcuts">
          {suggestions.map(([label, prompt]) => (
            <button
              key={label}
              type="button"
              onClick={() => setRequest(prompt)}
            >
              <span>{label}</span>
              <small>{prompt}</small>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
