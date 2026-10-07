'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  checkConnection,
  defaultConnection,
  type Connection,
  type RuntimeCapabilities
} from '@/api/workroom'

const CONNECTION_KEY = 'workfolio-backend-v2'

export default function useBackendConnection() {
  const [connection, setConnection] = useState<Connection>(defaultConnection)
  const [ready, setReady] = useState(false)
  const [revision, setRevision] = useState(0)
  const [status, setStatus] = useState<'checking' | 'online' | 'offline'>(
    'checking'
  )
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(
    null
  )
  const [error, setError] = useState('')

  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(CONNECTION_KEY) ?? 'null'
      )
      if (
        stored &&
        typeof stored === 'object' &&
        'baseUrl' in stored &&
        typeof stored.baseUrl === 'string'
      ) {
        setConnection({
          baseUrl: stored.baseUrl,
          token:
            'token' in stored && typeof stored.token === 'string'
              ? stored.token
              : ''
        })
      }
    } catch {
      /* Local mode also works when browser storage is unavailable. */
    }
    setReady(true)
  }, [])

  useEffect(() => {
    if (!ready) return
    let disposed = false
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setStatus('checking')
    async function check() {
      let delay = 30_000
      try {
        const next = await checkConnection(connection, fetch, controller.signal)
        if (disposed) return
        setCapabilities(next)
        setStatus('online')
        setError('')
      } catch (cause) {
        if (disposed) return
        setCapabilities(null)
        setStatus('offline')
        setError(
          cause instanceof Error ? cause.message : '백엔드 연결에 실패했습니다.'
        )
        delay = 5_000
      }
      if (!disposed) timer = setTimeout(() => void check(), delay)
    }
    void check()
    return () => {
      disposed = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [connection, ready, revision])

  const reconnect = useCallback(() => setRevision((value) => value + 1), [])
  const connect = useCallback((next: Connection, rememberToken: boolean) => {
    try {
      localStorage.setItem(
        CONNECTION_KEY,
        JSON.stringify({
          baseUrl: next.baseUrl,
          token: rememberToken ? next.token : ''
        })
      )
    } catch {
      /* Session-only connection is still usable. */
    }
    setConnection(next)
    setReady(true)
    setRevision((value) => value + 1)
  }, [])
  return { connection, ready, status, capabilities, error, reconnect, connect }
}
