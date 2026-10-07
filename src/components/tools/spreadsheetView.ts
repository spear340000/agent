import type { SpreadsheetInspection } from '@/api/automation'

export type SpreadsheetGrid = {
  columns: string[]
  columnWidths: number[]
  rows: Array<{ number: number; cells: string[] }>
}

type CellCoordinate = { column: number; row: number }

function parseAddress(address: string): CellCoordinate | null {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(address)
  if (!match) return null
  let column = 0
  for (const character of match[1]!.toUpperCase())
    column = column * 26 + character.charCodeAt(0) - 64
  const row = Number(match[2])
  if (!Number.isSafeInteger(row) || row < 1) return null
  return { column, row }
}

export function columnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

export function spreadsheetGrid(
  inspection: SpreadsheetInspection,
  sheetName?: string
): SpreadsheetGrid {
  const cells = inspection.cells.flatMap((cell) => {
    const address = parseAddress(cell.address)
    if (!address) return []
    return [{ ...address, value: cell.value, formula: cell.formula }]
  })

  if (!cells.length) return { columns: [], columnWidths: [], rows: [] }

  const sheet = inspection.sheets.find((item) => item.name === sheetName)
  const firstColumn = Math.min(...cells.map((cell) => cell.column))
  const firstRow = Math.min(...cells.map((cell) => cell.row))
  const maxColumn = Math.max(
    firstColumn,
    Math.min(
      Math.max(...cells.map((cell) => cell.column)),
      sheet?.columns ?? firstColumn + 25,
      firstColumn + 25
    )
  )
  const maxRow = Math.max(
    firstRow,
    Math.min(
      Math.max(...cells.map((cell) => cell.row)),
      sheet?.rows ?? firstRow + 49,
      firstRow + 49
    )
  )
  const values = new Map(
    cells
      .filter(
        (cell) =>
          cell.column >= firstColumn &&
          cell.column <= maxColumn &&
          cell.row >= firstRow &&
          cell.row <= maxRow
      )
      .map((cell) => [
        `${cell.row}:${cell.column}`,
        cell.formula ? `=${cell.formula}` : String(cell.value ?? '')
      ])
  )
  const columns = Array.from(
    { length: maxColumn - firstColumn + 1 },
    (_, index) => columnLabel(firstColumn + index - 1)
  )
  const columnWidths = columns.map((_, index) => {
    const column = firstColumn + index
    const longest = Math.max(
      0,
      ...cells
        .filter(
          (cell) =>
            cell.column === column && cell.row >= firstRow && cell.row <= maxRow
        )
        .map((cell) => {
          const value = cell.formula
            ? `=${cell.formula}`
            : String(cell.value ?? '')
          return Array.from(value).reduce(
            (width, character) =>
              width + (character.codePointAt(0)! > 0xff ? 2 : 1),
            0
          )
        })
    )
    return Math.min(280, Math.max(96, Math.ceil(longest * 7 + 24)))
  })
  const rows = Array.from({ length: maxRow - firstRow + 1 }, (_, index) => {
    const number = firstRow + index
    return {
      number,
      cells: columns.map(
        (_, columnIndex) =>
          values.get(`${number}:${firstColumn + columnIndex}`) ?? ''
      )
    }
  })
  return { columns, columnWidths, rows }
}
