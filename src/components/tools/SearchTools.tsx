'use client'

import React, { useState } from 'react'
import { officeApi, type WebSource } from '@/api/automation'
import { MOCK_BACKEND_ENABLED } from '@/mocks/mode'
import { ToolButton, type ToolProps } from './ToolFields'

export default function SearchTools({
  connection,
  busy,
  disabled,
  run
}: ToolProps) {
  const [query, setQuery] = useState('')
  const [sources, setSources] = useState<WebSource[]>([])
  const [searched, setSearched] = useState(false)
  return (
    <form
      className="workfolio-tool-form"
      onSubmit={(event) => {
        event.preventDefault()
        void run('웹 검색', async () => {
          const result = await officeApi.search(connection, query)
          setSources(result.items)
          setSearched(true)
          return { text: `${result.items.length}개 검색 결과를 확인했습니다.` }
        })
      }}
    >
      <h2>웹 검색</h2>
      <p>
        {MOCK_BACKEND_ENABLED
          ? '목업 모드에서는 실제 웹 검색을 실행하지 않습니다. 검색 화면만 확인할 수 있습니다.'
          : '검색어와 관련된 웹 자료를 확인합니다. 원문에 접근하지 못한 결과는 근거로 표시하지 않습니다.'}
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
      {MOCK_BACKEND_ENABLED && searched ? (
        <p role="status">
          목업 응답입니다. 검색 서비스에는 요청을 보내지 않았습니다.
        </p>
      ) : null}
      {!!sources.length && (
        <section aria-label="웹 검색 결과">
          {sources.map((source) => (
            <article key={source.url} className="workfolio-search-source">
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.title}
              </a>
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
