import React from 'react'
import type { TaskActivity } from './types'

/** What the backend reported while it worked, one entry per stage, with the records or sentences it touched. */
export default function ActivityLog({
  activity
}: {
  activity: TaskActivity[]
}) {
  return (
    <ul className="workfolio-activity" aria-label="처리 과정 기록">
      {activity.map((item) => (
        <li key={item.id}>
          <strong>{item.title}</strong>
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
