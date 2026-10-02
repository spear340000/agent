import React, { useMemo } from 'react'
import {
  parseMarkdownBlocks,
  renderInlineMarkdown,
  type MarkdownListItem
} from './markdown'

function ListItems({
  items,
  ordered,
  keyPrefix
}: {
  items: MarkdownListItem[]
  ordered: boolean
  keyPrefix: string
}) {
  const Tag = ordered ? 'ol' : 'ul'
  return (
    <Tag>
      {items.map((item, index) => (
        <li
          key={`${keyPrefix}-${index}`}
          {...(item.level > 0 ? { className: 'md-list__nested' } : {})}
        >
          {renderInlineMarkdown(item.text, `${keyPrefix}-${index}`)}
        </li>
      ))}
    </Tag>
  )
}

export default function MarkdownView({ value }: { value: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(value), [value])
  return (
    <div className="markdown-view">
      {blocks.map((block, index) => {
        const key = `md-${index}`
        switch (block.kind) {
          case 'heading': {
            const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4'
            return (
              <Tag key={key} data-level={block.level}>
                {renderInlineMarkdown(block.text, key)}
              </Tag>
            )
          }
          case 'quote':
            return (
              <blockquote key={key}>
                {renderInlineMarkdown(block.text, key)}
              </blockquote>
            )
          case 'list':
            return (
              <ListItems
                key={key}
                items={block.items}
                ordered={block.ordered}
                keyPrefix={key}
              />
            )
          case 'code':
            return (
              <pre key={key} data-language={block.language || undefined}>
                <code>{block.text}</code>
              </pre>
            )
          case 'rule':
            return <hr key={key} />
          case 'table':
            return (
              <div className="md-table-wrap" key={key} role="region" aria-label="문서 표" tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      {block.rows[0]?.map((cell, column) => (
                        <th key={`${key}-head-${column}`} scope="col">
                          {renderInlineMarkdown(cell, `${key}-head-${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.slice(1).map((row, rowIndex) => (
                      <tr key={`${key}-row-${rowIndex}`}>
                        {row.map((cell, column) => (
                          <td key={`${key}-cell-${rowIndex}-${column}`}>
                            {renderInlineMarkdown(cell, `${key}-cell-${rowIndex}-${column}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return (
              <p key={key}>{renderInlineMarkdown(block.text, key)}</p>
            )
        }
      })}
    </div>
  )
}
