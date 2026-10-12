'use client'

import React, { useState } from 'react'
import { officeApi, type WebSource } from '@/api/automation'
import { ToolButton, type ToolProps } from './ToolFields'
import { safeHttpUrl } from '@/components/workroom/safe-http-url'

export default function SearchTools({
  connection,
  busy,
  disabled,
  run
}: ToolProps) {
  const [query, setQuery] = useState('')
  const [sources, setSources] = useState<WebSource[]>([])
  return (
    <form
      className="workfolio-tool-form"
      onSubmit={(event) => {
        event.preventDefault()
        void run('웹 검색', async () => {
          const result = await officeApi.search(connection, query)
          setSources(result.items)
          return { text: `${result.items.length}개 검색 결과를 확인했습니다.` }
        })
      }}
    >
      <h2>웹 검색</h2>
      <p>
        검색어와 관련된 웹 자료를 확인합니다. 원문에 접근하지 못한 결과는 근거로
        표시하지 않습니다.
      </p>
      <label>
        검색어
        <input
          required
          maxLength={500}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <ToolButton busy={busy} disabled={disabled}>
        검색
      </ToolButton>
      {!!sources.length && (
        <section aria-label="웹 검색 결과">
          {sources.map((source) => (
            <article key={source.url} className="workfolio-search-source">
              {safeHttpUrl(source.url) ? (
                <a
                  href={safeHttpUrl(source.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {source.title}
                </a>
              ) : (
                <span>{source.title}</span>
              )}
              <p>
                {source.retrievalStatus === 'retrieved'
                  ? `원문 확인 · ${new Date(source.retrievedAt).toLocaleString('ko-KR')}`
                  : '원문 확인 불가 · 검색 요약은 검증된 근거가 아닙니다.'}
              </p>
              <pre>
                {source.retrievalStatus === 'retrieved'
                  ? source.content
                  : source.snippet}
              </pre>
            </article>
          ))}
        </section>
      )}
    </form>
  )
}
