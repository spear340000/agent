import React from 'react'
import type { TaskActivity } from './types'

function elapsed(from: number, at: number): string {
  const seconds = Math.max(0, at - from) / 1000
  return seconds < 0.5 ? '시작' : `+${seconds.toFixed(1)}초`
}

/** What the backend reported while it worked, with the time each stage was reached and the records it touched. */
export default function ActivityLog({
  activity,
  startedAt
}: {
  activity: TaskActivity[]
  startedAt?: number
}) {
  const origin = startedAt ?? activity[0]?.at ?? 0
  return (
    <ul className="workfolio-activity" aria-label="처리 과정 기록">
      {activity.map((item) => (
        <li key={item.id}>
          <strong>
            {item.title}
            {item.at > 0 ? (
              <time className="workfolio-activity__time">
                {elapsed(origin, item.at)}
              </time>
            ) : null}
          </strong>
          {item.detail ? <span>{item.detail}</span> : null}
          {item.items && item.items.length > 0 ? (
            <ul className="workfolio-activity__items">
              {item.items.map((line, index) => (
                <li key={`${item.id}-${index}`}>{line}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
