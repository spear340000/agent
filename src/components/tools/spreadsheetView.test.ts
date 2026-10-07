import assert from 'node:assert/strict'
import test from 'node:test'
import type { SpreadsheetInspection } from '@/api/automation'
import { columnLabel, spreadsheetGrid } from './spreadsheetView.js'

test('converts column indices to Excel labels', () => {
  assert.deepEqual([0, 25, 26, 51, 701].map(columnLabel), [
    'A',
    'Z',
    'AA',
    'AZ',
    'ZZ'
  ])
})

test('builds a bounded spreadsheet grid from inspected cell addresses', () => {
  const inspection: SpreadsheetInspection = {
    fileId: 'file-1',
    sheets: [{ name: '매출', rows: 20, columns: 5 }],
    cells: [
      { address: 'B2', value: '품목' },
      { address: 'C2', value: '수량' },
      { address: '$B$3', value: '사과' },
      { address: 'C3', value: 4 },
      { address: 'D3', value: 8, formula: 'C3*2' }
    ],
    formulaCalculation: 'not-performed'
  }

  assert.deepEqual(spreadsheetGrid(inspection, '매출'), {
    columns: ['B', 'C', 'D'],
    columnWidths: [96, 96, 96],
    rows: [
      { number: 2, cells: ['품목', '수량', ''] },
      { number: 3, cells: ['사과', '4', '=C3*2'] }
    ]
  })
})

test('ignores malformed addresses and caps rendered worksheet dimensions', () => {
  const inspection: SpreadsheetInspection = {
    fileId: 'file-1',
    sheets: [{ name: 'Sheet1', rows: 5000, columns: 500 }],
    cells: [
      { address: 'A1', value: 'start' },
      { address: 'ZZZ5000', value: 'far' },
      { address: 'not-a-cell', value: 'ignore' }
    ],
    formulaCalculation: 'not-performed'
  }
  const grid = spreadsheetGrid(inspection, 'Sheet1')
  assert.equal(grid.columns.length, 26)
  assert.equal(grid.rows.length, 50)
  assert.equal(grid.rows[0]?.cells[0], 'start')
})

test('sizes the preview to populated cells instead of expanding to the requested blank range', () => {
  const inspection: SpreadsheetInspection = {
    fileId: 'file-2',
    selectedSheet: '매출',
    range: 'C4:E8',
    sheets: [{ name: '매출', rows: 8, columns: 5 }],
    cells: [
      { address: 'D5', value: '품목' },
      { address: 'E5', value: 4 },
      {
        address: 'E8',
        value:
          '이 설명은 열 너비 상한을 넘는 긴 문장이라도 표의 너비를 과도하게 키우지 않습니다.'
      }
    ],
    formulaCalculation: 'not-performed'
  }

  const grid = spreadsheetGrid(inspection, '매출')
  assert.deepEqual(grid.columns, ['D', 'E'])
  assert.deepEqual(grid.rows, [
    { number: 5, cells: ['품목', '4'] },
    { number: 6, cells: ['', ''] },
    { number: 7, cells: ['', ''] },
    {
      number: 8,
      cells: [
        '',
        '이 설명은 열 너비 상한을 넘는 긴 문장이라도 표의 너비를 과도하게 키우지 않습니다.'
      ]
    }
  ])
  assert.deepEqual(grid.columnWidths, [96, 280])
})
