'use client'

import React, { useState } from 'react'
import { officeApi } from '@/api/automation'
import { ToolButton, type ToolProps } from './ToolFields'

export default function ComputerTools({
  connection,
  busy,
  disabled,
  run,
  available
}: ToolProps & { available: boolean }) {
  const [action, setAction] = useState<'screenshot' | 'click' | 'type'>(
    'screenshot'
  )
  const [x, setX] = useState(0),
    [y, setY] = useState(0)
  const [text, setText] = useState('')
  return (
    <form
      className="workfolio-tool-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!available || disabled || busy) return
        void run('컴퓨터 작업', () =>
          officeApi.computerAction(
            connection,
            action === 'click'
              ? { kind: action, x, y }
              : action === 'type'
                ? { kind: action, text }
                : { kind: action }
          )
        )
      }}
    >
      <h2>네이티브 컴퓨터 제어</h2>
      <p>
        백엔드가 실행 중인 Windows의 기본 화면을 제어합니다. 클릭·입력은 백엔드
        터미널에서 한 번 더 승인해야 실행됩니다.
      </p>
      {!available && (
        <p className="workfolio-tool-error" role="status">
          현재 비활성화되어 있습니다. Windows 백엔드에서
          COMPUTER_USE_ENABLED=true로 명시적으로 활성화한 경우에만 사용할 수
          있습니다.
        </p>
      )}
      <label>
        작업
        <select
          value={action}
          onChange={(event) => setAction(event.target.value as typeof action)}
        >
          <option value="screenshot">화면 캡처</option>
          <option value="click">좌표 클릭</option>
          <option value="type">키보드 입력</option>
        </select>
      </label>
      {action === 'click' && (
        <div className="workfolio-tool-row">
          <label>
            X 좌표
            <input
              type="number"
              required
              min={0}
              max={20000}
              value={x}
              onChange={(event) => setX(Number(event.target.value))}
            />
          </label>
          <label>
            Y 좌표
            <input
              type="number"
              required
              min={0}
              max={20000}
              value={y}
              onChange={(event) => setY(Number(event.target.value))}
            />
          </label>
        </div>
      )}
      {action === 'type' && (
        <label>
          입력 내용
          <textarea
            required
            maxLength={10000}
            rows={5}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
      )}
      <ToolButton busy={busy} disabled={disabled || !available}>
        {action === 'screenshot' ? '화면 캡처' : '승인 요청 후 실행'}
      </ToolButton>
    </form>
  )
}
