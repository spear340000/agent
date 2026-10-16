import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  getTaskTrace,
  type Connection,
  type TaskTrace
} from '../../api/workroom'

/** How often a running task's trace is read again while its flow is open. */
export const TRACE_REFRESH_MS = 3_000

export type TraceState = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  /** The last trace that was read. It stays on screen while a newer one is being read, or after a failed read. */
  trace?: TaskTrace
  message?: string
}

export type TraceAction =
  | { type: 'start' }
  | { type: 'loaded'; trace: TaskTrace }
  | { type: 'failed'; message: string }

export const initialTraceState: TraceState = { phase: 'idle' }

export function traceReducer(
  state: TraceState,
  action: TraceAction
): TraceState {
  switch (action.type) {
    case 'start':
      // Reloading keeps the trace already on screen, so a live refresh does not flash back to "loading".
      return {
        ...state,
        phase: state.trace ? 'ready' : 'loading',
        message: undefined
      }
    case 'loaded':
      return { phase: 'ready', trace: action.trace }
    case 'failed':
      return { ...state, phase: 'error', message: action.message }
  }
}

/**
 * Reads a task's run trace once the flow is opened. While the task is queued or running, the trace is read again every
 * few seconds; once it stops, one last read shows the final state and the refreshing ends.
 */
export function useTaskTrace(
  taskId: string,
  connection: Connection | undefined,
  options: { enabled: boolean; live: boolean }
): TraceState {
  const [state, dispatch] = useReducer(traceReducer, initialTraceState)
  const inFlight = useRef(false)

  const load = useCallback(() => {
    if (!connection || inFlight.current) return
    inFlight.current = true
    dispatch({ type: 'start' })
    getTaskTrace(taskId, connection)
      .then((trace) => dispatch({ type: 'loaded', trace }))
      .catch((error: unknown) =>
        dispatch({
          type: 'failed',
          message:
            error instanceof Error
              ? error.message
              : '처리 시간을 불러오지 못했습니다.'
        })
      )
      .finally(() => {
        inFlight.current = false
      })
  }, [taskId, connection])

  const { enabled, live } = options
  useEffect(() => {
    if (!enabled) return
    load()
    if (!live) return
    const timer = setInterval(load, TRACE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [enabled, live, load])

  return state
}
