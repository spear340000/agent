import assert from 'node:assert/strict'
import test from 'node:test'
import { Table } from 'docx'
import { markdownToDocxBlocks } from './markdownDocx'

test('Markdown tables export as fixed-grid Word tables with a repeated header', () => {
  const blocks = markdownToDocxBlocks(
    '# 보고서\n\n| 항목 | 기준 | 결과 |\n|:---|:---:|---:|\n| 위탁 | **계약 확인** | 필요 |\n| 공개 | 제한 | `검토` |'
  )
  const tables = blocks.filter(
    (block): block is Table => block instanceof Table
  )

  assert.equal(tables.length, 1)
  assert.equal(blocks.filter((block) => !(block instanceof Table)).length, 1)
})

test('Markdown headings, lists, and prose become separate Word blocks', () => {
  const blocks = markdownToDocxBlocks(
    '## 쟁점\n\n본문 **강조**\n\n- 항목 하나\n- 항목 둘'
  )
  assert.equal(blocks.filter((block) => !(block instanceof Table)).length, 4)
})
