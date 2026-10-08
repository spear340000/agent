import React from 'react'
import type { TaskModelTotals } from './types'

const number = (value: number): string => value.toLocaleString('ko-KR')

/** One readable line: calls, tokens in and out, time spent in the model, and average output speed. */
export function modelUsageText(totals: TaskModelTotals): string {
  return [
    `모델 호출 ${totals.calls}회${totals.failedCalls > 0 ? `(실패 ${totals.failedCalls}회)` : ''}`,
    `입력 ${number(totals.promptTokens)} / 출력 ${number(totals.completionTokens)} 토큰`,
    `모델 시간 ${(totals.totalMs / 1000).toFixed(1)}초`,
    totals.tokensPerSecond
      ? `평균 ${totals.tokensPerSecond.toFixed(0)} tok/s`
      : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

export default function ModelUsage({ totals }: { totals?: TaskModelTotals }) {
  if (!totals || totals.calls === 0) return null
  return <p className="task-context__model-usage">{modelUsageText(totals)}</p>
}
