'use client'

import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { checkConnection, type Connection } from '@/api/workroom'

export default function ConnectionDialog({
  connection,
  onConnect,
  onClose
}: {
  connection: Connection
  onConnect: (value: Connection, remember: boolean) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef<AbortController | null>(null)
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl)
  const [token, setToken] = useState(connection.token)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
    return () => pending.current?.abort()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="workfolio-dialog"
      aria-labelledby="connection-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header>
        <h2 id="connection-title">백엔드 연결</h2>
        <button type="button" aria-label="연결 설정 닫기" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <p>
        로컬 모드에서는 토큰이 필요 없습니다. 인증을 켠 서버에 연결할 때만
        입력하세요.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          if (busy) return
          setBusy(true)
          setError('')
          const controller = new AbortController()
          pending.current = controller
          try {
            const next = { baseUrl: baseUrl.trim(), token: token.trim() }
            await checkConnection(next, fetch, controller.signal)
            if (controller.signal.aborted) return
            onConnect(next, remember)
            onClose()
          } catch (cause) {
            if (controller.signal.aborted) return
            setError(
              cause instanceof Error ? cause.message : '연결에 실패했습니다.'
            )
          } finally {
            if (!controller.signal.aborted) setBusy(false)
            if (pending.current === controller) pending.current = null
          }
        }}
      >
        <label>
          백엔드 주소
          <input
            type="url"
            required
            disabled={busy}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label>
          API 토큰 (선택)
          <input
            type="password"
            autoComplete="off"
            disabled={busy}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <label className="workfolio-checkbox">
          <input
            type="checkbox"
            disabled={busy}
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          이 브라우저에 토큰 저장
        </label>
        {error && (
          <p className="workfolio-tool-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="workfolio-primary" disabled={busy}>
          {busy ? '연결 확인 중…' : '연결 확인 및 저장'}
        </button>
      </form>
    </dialog>
  )
}
