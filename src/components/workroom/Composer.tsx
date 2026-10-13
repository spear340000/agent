'use client'
// 요청 문장과 파일·링크를 입력받아 하나의 새 작업 또는 추가 요청으로 전달한다.
import { useRef, useState } from 'react'
import React from 'react'
import { ArrowUp, FilePlus2, Link2, X } from 'lucide-react'
import { validateSourceFile } from '@/api/workroom'
import type { Source, SourceUploadProgress } from './types'
type ComposerDraft = {
  request: string
  sources: Source[]
  link: string
  linkOpen: boolean
}
const composerDrafts = new Map<string, ComposerDraft>()
const MAX_STORED_COMPOSER_DRAFTS = 50

function storeComposerDraft(key: string | undefined, draft: ComposerDraft) {
  if (!key) return
  if (
    !draft.request &&
    !draft.sources.length &&
    !draft.link &&
    !draft.linkOpen
  ) {
    composerDrafts.delete(key)
    return
  }
  composerDrafts.delete(key)
  composerDrafts.set(key, draft)
  if (composerDrafts.size > MAX_STORED_COMPOSER_DRAFTS) {
    const oldest = composerDrafts.keys().next().value
    if (oldest) composerDrafts.delete(oldest)
  }
}
const suggestions = [
  ['조문 확인', '민법 제398조가 정하는 손해배상 예정은 어떻게 되나요?'],
  [
    '요금분쟁',
    '임대인이 보증금을 갚지 않을 때 제가 할 수 있는 법적 대응은 무엇인가요?'
  ],
  [
    '문서 초안',
    '임대차 해지 통보문 초안을 작성해 주세요. 보증금은 1억 원입니다.'
  ]
]
export default function Composer({
  onSubmit,
  compact = false,
  disabled = false,
  modelUnavailable = false,
  placeholder,
  draftKey,
  workflow: initialWorkflow = 'legal'
}: {
  onSubmit: (
    request: string,
    sources: Source[],
    workflow?: 'legal' | 'document',
    onUploadProgress?: (progress: SourceUploadProgress) => void
  ) => void | boolean | Promise<void | boolean>
  compact?: boolean
  disabled?: boolean
  modelUnavailable?: boolean
  placeholder?: string
  draftKey?: string
  workflow?: 'legal' | 'document'
}) {
  const initialDraft = draftKey ? composerDrafts.get(draftKey) : undefined
  const [workflow, setWorkflow] = useState(initialWorkflow)
  const [request, setRequest] = useState(initialDraft?.request ?? '')
  const [sources, setSources] = useState<Source[]>(initialDraft?.sources ?? [])
  const [link, setLink] = useState(initialDraft?.link ?? '')
  const [linkOpen, setLinkOpen] = useState(initialDraft?.linkOpen ?? false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploadProgress, setUploadProgress] =
    useState<SourceUploadProgress | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const submissionBlocked = disabled || modelUnavailable

  React.useEffect(() => {
    storeComposerDraft(draftKey, { request, sources, link, linkOpen })
  }, [draftKey, link, linkOpen, request, sources])

  function addLink() {
    try {
      const url = new URL(link.trim())
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error(
          'http:// 또는 https://로 시작하는 주소를 입력해 주세요.'
        )
      if (url.username || url.password)
        throw new Error('로그인 정보가 포함된 주소는 추가할 수 없습니다.')
      if (url.href.length > 2048)
        throw new Error('웹 주소는 2,048자 이내로 입력해 주세요.')
      if (
        sources.some(
          (source) => source.kind === 'link' && source.url === url.href
        )
      )
        throw new Error('이미 추가한 링크입니다.')
      if (sources.filter((source) => source.kind === 'link').length >= 5)
        throw new Error('링크는 최대 5개까지 추가할 수 있습니다.')
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
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : 'http:// 또는 https://로 시작하는 주소를 입력해 주세요.'
      )
    }
  }
  return (
    <>
      <form
        className={`composer ${compact ? 'composer-compact' : ''}`}
        onSubmit={async (event) => {
          event.preventDefault()
          if (!request.trim() || submitting || submissionBlocked) return
          setSubmitting(true)
          setUploadProgress(null)
          try {
            const accepted = await onSubmit(
              request,
              sources,
              workflow,
              setUploadProgress
            )
            if (accepted !== false) {
              if (draftKey) composerDrafts.delete(draftKey)
              setRequest('')
              setSources([])
              setError('')
            }
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : '요청을 보내지 못했습니다.'
            )
          } finally {
            setSubmitting(false)
            setUploadProgress(null)
          }
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
            placeholder ??
            (compact
              ? '추가로 원하는 내용을 입력해 주세요.'
              : '궁금한 법률 질문이나 작성할 문서를 설명해 주세요.')
          }
          maxLength={12000}
          aria-label="작업 요청"
          disabled={disabled || submitting}
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
              maxLength={2048}
              aria-label="웹 주소"
              disabled={disabled || submitting}
            />
            <button
              type="button"
              onClick={addLink}
              disabled={disabled || submitting}
            >
              추가
            </button>
            <button
              type="button"
              onClick={() => setLinkOpen(false)}
              aria-label="링크 입력 닫기"
              disabled={disabled || submitting}
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
              disabled={disabled || submitting}
            >
              <FilePlus2 size={16} /> 파일 추가
            </button>
            <button
              type="button"
              className="tool-button"
              onClick={() => setLinkOpen(true)}
              disabled={disabled || submitting}
            >
              <Link2 size={16} /> 링크 추가
            </button>
            {sources.length > 0 && (
              <span className="attachment-count">자료 {sources.length}개</span>
            )}
          </div>
          <button
            className="send-button"
            disabled={!request.trim() || submitting || submissionBlocked}
            aria-label={compact ? '추가 요청 보내기' : '작업 시작'}
          >
            <ArrowUp size={17} />
          </button>
        </div>{' '}
        {sources.length > 0 && (
          <div className="attachment-list">
            {sources.map((source, index) => (
              <span className="attachment" key={source.id}>
                <span>{source.name}</span>
                <button
                  type="button"
                  disabled={disabled || submitting}
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
        {uploadProgress ? (
          <p className="composer-upload-progress" role="status">
            자료 업로드 {uploadProgress.completed}/{uploadProgress.total}:{' '}
            {uploadProgress.current}
          </p>
        ) : null}
        <input
          ref={fileInput}
          hidden
          type="file"
          multiple
          accept=".pdf,.docx,.pptx,.xlsx,.txt,.csv"
          disabled={disabled || submitting}
          onChange={(event) => {
            const selected = Array.from(event.target.files || [])
            let fileCount = sources.filter(
              (source) => source.kind === 'file'
            ).length
            const accepted: Source[] = []
            const errors: string[] = []
            for (const file of selected) {
              if (fileCount >= 5) {
                errors.push('파일은 최대 5개까지 추가할 수 있습니다.')
                break
              }
              try {
                validateSourceFile(file)
                accepted.push({
                  id: crypto.randomUUID(),
                  name: file.name,
                  kind: 'file',
                  file,
                  status: 'queued'
                })
                fileCount += 1
              } catch (cause) {
                errors.push(
                  cause instanceof Error
                    ? cause.message
                    : `${file.name}: 지원하지 않는 파일입니다.`
                )
              }
            }
            if (accepted.length)
              setSources((current) => [...current, ...accepted])
            setError(errors.join(' '))
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
        <div className="composer-mode" role="group" aria-label="처리 방식">
          <button
            type="button"
            aria-pressed={workflow === 'legal'}
            onClick={() => setWorkflow('legal')}
          >
            법률 답변
          </button>
          <button
            type="button"
            aria-pressed={workflow === 'document'}
            onClick={() => setWorkflow('document')}
          >
            문서 작업
          </button>
          <p>
            {workflow === 'legal'
              ? '로컬 법령·판례 저장소를 찾아 인용과 함께 답변합니다.'
              : '법령 검색 없이 첨부 자료와 웹 자료로 문서만 만듭니다.'}
          </p>
        </div>
      )}
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
