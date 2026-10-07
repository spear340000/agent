import React from 'react'
import { FileText } from 'lucide-react'
import type { DocumentHeading } from './documentModel'

export type DocumentOutlineProps = {
  headings: DocumentHeading[]
  onSelect: (heading: DocumentHeading) => void
}

export default function DocumentOutline({
  headings,
  onSelect
}: DocumentOutlineProps) {
  if (headings.length === 0) return null

  return (
    <nav className="document-outline" aria-label="문서 목차">
      <div className="document-outline__heading">
        <FileText aria-hidden="true" size={15} />
        <span>목차</span>
      </div>
      <ol className="document-outline__list">
        {headings.map((heading) => (
          <li key={`${heading.start}-${heading.level}`}>
            <button
              className="document-outline__item"
              data-level={heading.level}
              type="button"
              onClick={() => onSelect(heading)}
              title={heading.title}
            >
              {heading.title || '제목 없음'}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
