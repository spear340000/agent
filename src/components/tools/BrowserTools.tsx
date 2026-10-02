'use client'

import React, { useEffect, useRef, useState } from 'react'
import { officeApi, type BrowserResult } from '@/api/automation'
import { ToolButton, type ToolProps } from './ToolFields'

export default function BrowserTools({
  connection,
  busy,
  disabled,
  run,
  available
}: ToolProps & { available: boolean }) {
  const [session, setSession] = useState<BrowserResult | null>(null)
  const [url, setUrl] = useState('')
  const [action, setAction] = useState<
    'navigate' | 'extractText' | 'screenshot' | 'click' | 'type'
  >('navigate')
  const [selector, setSelector] = useState('')
  const [text, setText] = useState('')
  const sessionId = useRef<string | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (sessionId.current)
        void officeApi
          .closeBrowser(connection, sessionId.current)
          .catch(() => undefined)
    }
  }, [connection])
  return (
    <form
      className="workfolio-tool-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!available || disabled || busy) return
        void run('브라우저 작업', async () => {
          const result = session
            ? await officeApi.browserAction(
                connection,
                session.sessionId,
                action === 'navigate'
                  ? { kind: action, url }
                  : action === 'type'
                    ? { kind: action, selector, text }
                    : action === 'click'
                      ? { kind: action, selector }
                      : { kind: action }
              )
            : await officeApi.createBrowser(connection, url || undefined)
          if (!mounted.current) {
            await officeApi.closeBrowser(connection, result.sessionId)
            return result
          }
          sessionId.current = result.sessionId
          setSession(result)
          return result
        })
      }}
    >
      <h2>브라우저 자동화</h2>
      <p>
        실제 Chrome 세션에서 공개 웹페이지를 탐색하고, 요소를 클릭하거나
        입력하고, 텍스트와 화면을 가져옵니다. 사설망·로컬 주소는 차단됩니다.
      </p>
      {!available && (
        <p className="workfolio-tool-error" role="status">
          Chrome 실행 파일을 찾지 못했습니다. 백엔드의 BROWSER_EXECUTABLE_PATH를
          확인하세요.
        </p>
      )}
      {session && (
        <>
          <p className="workfolio-browser-location">
            {session.title || '열린 페이지'}
            <br />
            {session.url}
          </p>
          <label>
            작업
            <select
              value={action}
              onChange={(event) =>
                setAction(event.target.value as typeof action)
              }
            >
              <option value="navigate">페이지 이동</option>
              <option value="extractText">본문 추출</option>
              <option value="screenshot">스크린샷</option>
              <option value="click">요소 클릭</option>
              <option value="type">요소에 입력</option>
            </select>
          </label>
        </>
      )}
      {(!session || action === 'navigate') && (
        <label>
          페이지 URL
          <input
            type="url"
            value={url}
            required={!!session}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://"
          />
        </label>
      )}
      {(action === 'click' || action === 'type') && session && (
        <label>
          CSS 선택자
          <input
            required
            maxLength={2000}
            value={selector}
            onChange={(event) => setSelector(event.target.value)}
          />
        </label>
      )}
      {action === 'type' && session && (
        <label>
          입력 내용
          <textarea
            required
            maxLength={100000}
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
      )}
      <ToolButton busy={busy} disabled={disabled || !available}>
        {session ? '실행' : '브라우저 세션 시작'}
      </ToolButton>
      {session && (
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() =>
            void run('브라우저 세션 종료', async () => {
              await officeApi.closeBrowser(connection, session.sessionId)
              sessionId.current = undefined
              setSession(null)
              return { text: '브라우저 세션을 종료했습니다.' }
            })
          }
        >
          세션 종료
        </button>
      )}
    </form>
  )
}
