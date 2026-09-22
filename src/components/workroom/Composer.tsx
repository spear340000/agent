'use client'
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Plus, X } from 'lucide-react'
import type { Source } from './types'

const suggestions = [
  ['자료 조사', '다음 주제에 대해 자료를 조사하고 보고서로 정리해줘: '],
  ['자료 비교', '첨부한 자료들의 공통점과 차이점을 비교 문서로 정리해줘.'],
  [
    '기획안 작성',
    '다음 내용을 바탕으로 목적, 실행 방안, 일정을 포함한 기획 초안을 작성해줘: '
  ],
  ['문서 보완', '첨부한 문서를 다음 요청에 맞게 수정하고 보완해줘: ']
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
  const [menu, setMenu] = useState(false)
  const [showLink, setShowLink] = useState(false)
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const files = useRef<HTMLInputElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const menuRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!menuRoot.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  function addLink() {
    try {
      const url = new URL(link.trim())
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
      setSources((old) => [...old, { name: url.href, url: url.href }])
      setLink('')
      setShowLink(false)
      setError('')
    } catch {
      setError('http:// 또는 https://로 시작하는 주소를 입력해주세요.')
    }
  }
  return (
    <>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          if (!request.trim()) return
          onSubmit(request.trim(), sources)
          setRequest('')
          setSources([])
          setError('')
          setShowLink(false)
          setMenu(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setMenu(false)
            setShowLink(false)
          }
        }}
      >
        <textarea
          ref={input}
          aria-label={compact ? '추가 요청' : '작업 요청'}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          maxLength={12000}
          placeholder={
            compact
              ? '이 작업에 추가할 요청사항을 적어주세요.'
              : '만들고 싶은 문서와 요청사항을 적어주세요.'
          }
        />
        <div className="attachments">
          {sources.map((source, i) => (
            <span className="attachment" key={i}>
              <span>{source.name}</span>
              <button
                type="button"
                aria-label={`${source.name} 제거`}
                onClick={() =>
                  setSources((old) => old.filter((_, j) => i !== j))
                }
              >
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
        {showLink && (
          <div className="link-entry">
            <input
              autoFocus
              aria-label="웹 링크"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://example.com"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  addLink()
                }
              }}
            />
            <button type="button" onClick={addLink}>
              추가
            </button>
            <button type="button" onClick={() => setShowLink(false)}>
              닫기
            </button>
          </div>
        )}
        <div className="toolbar">
          <div className="attachment-control" ref={menuRoot}>
            <button
              type="button"
              className="icon-button"
              aria-label="파일 또는 링크 추가"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <Plus size={20} />
            </button>
            {menu && (
              <div className="menu">
                <button
                  type="button"
                  onClick={() => {
                    files.current?.click()
                    setMenu(false)
                  }}
                >
                  파일 첨부<small>PDF, DOCX, PPTX</small>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLink(true)
                    setMenu(false)
                  }}
                >
                  웹 링크 추가
                </button>
              </div>
            )}
          </div>
          <button
            className="icon-button send"
            disabled={!request.trim()}
            aria-label={compact ? '추가 요청 보내기' : '작업 시작'}
          >
            <ArrowUp size={19} />
          </button>
        </div>
        <input
          ref={files}
          type="file"
          multiple
          accept=".pdf,.docx,.pptx"
          hidden
          onChange={(e) => {
            const selected = Array.from(e.target.files || [])
            setSources((old) => [
              ...old,
              ...selected
                .filter((f) => /\.(pdf|docx|pptx)$/i.test(f.name))
                .map((f) => ({ name: f.name }))
            ])
            setError(
              selected.some((f) => !/\.(pdf|docx|pptx)$/i.test(f.name))
                ? 'PDF, DOCX, PPTX만 첨부할 수 있습니다.'
                : ''
            )
            e.target.value = ''
          }}
        />
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
      {!compact && (
        <div className="shortcuts">
          {suggestions.map(([label, prompt]) => (
            <button
              key={label}
              onClick={() => {
                setRequest(prompt)
                input.current?.focus()
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
