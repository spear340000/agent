'use client'

import React, { useEffect, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import {
  DEFAULT_CONTEXT_PANE_WIDTH,
  MAX_CONTEXT_PANE_WIDTH,
  MIN_CONTEXT_PANE_WIDTH,
  resizeContextPaneWidth
} from './splitPaneModel'

const CONTEXT_PANE_WIDTH_KEY = 'workfolio-context-pane-width-v1'

type WorkfolioSplitLayoutProps = {
  context: ReactNode
  workArea: ReactNode
  contextDrawerOpen?: boolean
}

export default function WorkfolioSplitLayout({
  context,
  workArea,
  contextDrawerOpen = false
}: WorkfolioSplitLayoutProps) {
  const [contextWidth, setContextWidth] = useState(DEFAULT_CONTEXT_PANE_WIDTH)
  const [preferenceLoaded, setPreferenceLoaded] = useState(false)
  const [resizing, setResizing] = useState(false)
  const layoutRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{
    pointerId: number
    x: number
    width: number
  } | null>(null)
  const pendingWidth = useRef(DEFAULT_CONTEXT_PANE_WIDTH)

  useEffect(() => {
    try {
      const savedWidth = localStorage.getItem(CONTEXT_PANE_WIDTH_KEY)
      if (savedWidth !== null) {
        const parsedWidth = Number(savedWidth)
        setContextWidth(resizeContextPaneWidth(parsedWidth, 0))
      }
    } catch {
      // Keep the default split when browser storage is unavailable.
    } finally {
      setPreferenceLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!preferenceLoaded) return
    try {
      localStorage.setItem(CONTEXT_PANE_WIDTH_KEY, String(contextWidth))
    } catch {
      // Resizing still works for this session when browser storage is unavailable.
    }
  }, [contextWidth, preferenceLoaded])

  function finishResize() {
    if (!dragStart.current) return
    dragStart.current = null
    setResizing(false)
    setContextWidth(pendingWidth.current)
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: contextWidth
    }
    pendingWidth.current = contextWidth
    setResizing(true)
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = dragStart.current
    if (
      !start ||
      start.pointerId !== event.pointerId ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      return
    }
    const nextWidth = resizeContextPaneWidth(
      start.width,
      start.x - event.clientX
    )
    pendingWidth.current = nextWidth
    layoutRef.current?.style.setProperty('--wf-context-width', `${nextWidth}px`)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const adjustment = event.shiftKey ? 25 : 10
    let nextWidth: number | null = null

    if (event.key === 'ArrowLeft') nextWidth = contextWidth + adjustment
    else if (event.key === 'ArrowRight') nextWidth = contextWidth - adjustment
    else if (event.key === 'Home') nextWidth = MIN_CONTEXT_PANE_WIDTH
    else if (event.key === 'End') nextWidth = MAX_CONTEXT_PANE_WIDTH

    if (nextWidth === null) return
    event.preventDefault()
    setContextWidth(resizeContextPaneWidth(nextWidth, 0))
  }

  return (
    <div
      className={[
        'workfolio-active-layout',
        resizing && 'workfolio-active-layout--resizing',
        contextDrawerOpen && 'workfolio-active-layout--context-open'
      ]
        .filter(Boolean)
        .join(' ')}
      ref={layoutRef}
      style={
        { '--wf-context-width': `${contextWidth}px` } as React.CSSProperties
      }
    >
      {workArea}
      <div
        className="workfolio-splitter"
        role="separator"
        aria-label="작업 정보 패널 너비 조절"
        aria-orientation="vertical"
        aria-valuemin={MIN_CONTEXT_PANE_WIDTH}
        aria-valuemax={MAX_CONTEXT_PANE_WIDTH}
        aria-valuenow={contextWidth}
        title="드래그하거나 화살표 키로 작업 정보 패널 너비 조절"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
      />
      {context}
    </div>
  )
}
