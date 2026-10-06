'use client'

import React, { useState } from 'react'
import {
  officeApi,
  type Scalar,
  type SpreadsheetInspection,
  type SpreadsheetOperation
} from '@/api/automation'
import { FileField, ToolButton, type ToolProps } from './ToolFields'
import { parseRows } from './toolInputs'
import { spreadsheetGrid } from './spreadsheetView'

export default function SpreadsheetTools({
  connection,
  files,
  busy,
  disabled,
  run
}: ToolProps) {
  const [mode, setMode] = useState<'inspect' | 'create' | 'edit'>('inspect')
  const [fileId, setFileId] = useState('')
  const [outputName, setOutputName] = useState('')
  const [sheet, setSheet] = useState('')
  const [range, setRange] = useState('')
  const [kind, setKind] = useState<SpreadsheetOperation['kind']>('setCell')
  const [cell, setCell] = useState('A1')
  const [value, setValue] = useState('')
  const [valueType, setValueType] = useState<
    'text' | 'number' | 'boolean' | 'empty'
  >('text')
  const [delimiter, setDelimiter] = useState<',' | '\t'>('\t')
  const [inspection, setInspection] = useState<SpreadsheetInspection | null>(
    null
  )
  const [operations, setOperations] = useState<SpreadsheetOperation[]>([])
  const [inputError, setInputError] = useState('')
  const [selectedCell, setSelectedCell] = useState('')
  const previewGrid = inspection
    ? spreadsheetGrid(inspection, inspection.selectedSheet)
    : null

  function currentOperation(): SpreadsheetOperation {
    if (!sheet.trim()) throw new Error('시트 이름을 입력하세요.')
    if (kind === 'addSheet') return { kind, name: sheet.trim() }
    if (kind === 'appendRows')
      return { kind, sheet, rows: parseRows(value, delimiter) }
    if (kind === 'setFormula')
      return { kind, sheet, cell, formula: value.replace(/^=/, '') }
    let scalar: Scalar = value
    if (valueType === 'number') {
      if (!value.trim() || !Number.isFinite(Number(value)))
        throw new Error('유한한 숫자를 입력하세요.')
      scalar = Number(value)
    }
    if (valueType === 'boolean') {
      if (!['true', 'false'].includes(value.toLowerCase()))
        throw new Error('true 또는 false를 입력하세요.')
      scalar = value.toLowerCase() === 'true'
    }
    if (valueType === 'empty') scalar = null
    return { kind, sheet, cell, value: scalar }
  }
  return (
    <>
      <form
        className="workfolio-tool-form workfolio-spreadsheet-form"
        onSubmit={(event) => {
          event.preventDefault()
          setInputError('')
          void run('Excel 작업', async () => {
            if (mode === 'inspect') {
              let result = await officeApi.inspectSpreadsheet(connection, {
                fileId,
                ...(sheet.trim()
                  ? {
                      sheet: sheet.trim(),
                      ...(range.trim() ? { range: range.trim() } : {})
                    }
                  : {})
              })
              if (!sheet.trim() && result.sheets[0]) {
                const firstSheet = result.sheets[0].name
                setSheet(firstSheet)
                result = await officeApi.inspectSpreadsheet(connection, {
                  fileId,
                  sheet: firstSheet,
                  ...(range.trim() ? { range: range.trim() } : {})
                })
              }
              setInspection(result)
              return undefined
            }
            const pending = operations.length
              ? operations
              : [currentOperation()]
            if (mode === 'create' && pending[0]?.kind !== 'addSheet')
              throw new Error('새 Excel은 시트 추가 작업부터 시작하세요.')
            const result = await officeApi.spreadsheet(connection, {
              fileId: mode === 'edit' ? fileId : undefined,
              outputName,
              operations: pending
            })
            setOperations([])
            return result
          })
        }}
      >
        <h2>Excel 작업</h2>
        <p>
          셀·수식·행·시트를 실제 XLSX 파일에 적용합니다. 수식은 저장하며 계산
          결과는 Excel 등에서 열 때 갱신됩니다.
        </p>
        <label>
          작업
          <select
            value={mode}
            onChange={(event) => {
              const next = event.target.value as typeof mode
              setMode(next)
              setOperations([])
              setKind(next === 'create' ? 'addSheet' : 'setCell')
              setInspection(null)
              setSelectedCell('')
            }}
          >
            <option value="inspect">시트·셀 조회</option>
            <option value="create">새 Excel 생성</option>
            <option value="edit">기존 Excel 편집</option>
          </select>
        </label>
        {mode !== 'create' && (
          <FileField
            files={files.filter((file) =>
              file.name.toLowerCase().endsWith('.xlsx')
            )}
            value={fileId}
            onChange={(id) => {
              setFileId(id)
              setInspection(null)
              setOperations([])
              setSelectedCell('')
            }}
          />
        )}
        {mode !== 'inspect' && (
          <label>
            결과 파일 이름
            <input
              required
              value={outputName}
              onChange={(event) => setOutputName(event.target.value)}
            />
          </label>
        )}
        <label>
          {mode === 'inspect'
            ? '시트 이름 (비우면 첫 번째 시트 조회)'
            : '시트 이름'}
          <input
            list="workfolio-sheet-names"
            required={mode !== 'inspect' && !operations.length}
            maxLength={31}
            value={sheet}
            onChange={(event) => setSheet(event.target.value)}
          />
        </label>
        <datalist id="workfolio-sheet-names">
          {inspection?.sheets.map((item) => (
            <option key={item.name} value={item.name} />
          ))}
        </datalist>
        {mode === 'inspect' ? (
          <label>
            셀 범위
            <input
              value={range}
              onChange={(event) => setRange(event.target.value)}
              placeholder="비우면 사용 영역 전체 (최대 5,000셀)"
            />
          </label>
        ) : (
          <>
            <label>
              편집 종류
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as typeof kind)}
              >
                <option value="addSheet">시트 추가</option>
                <option value="setCell">셀 값 변경</option>
                <option value="setFormula">수식 설정</option>
                <option value="appendRows">행 추가</option>
              </select>
            </label>
            {(kind === 'setCell' || kind === 'setFormula') && (
              <label>
                셀 주소
                <input
                  value={cell}
                  onChange={(event) => setCell(event.target.value)}
                />
              </label>
            )}
            {kind === 'setCell' && (
              <label>
                값 유형
                <select
                  value={valueType}
                  onChange={(event) =>
                    setValueType(event.target.value as typeof valueType)
                  }
                >
                  <option value="text">텍스트</option>
                  <option value="number">숫자</option>
                  <option value="boolean">참/거짓</option>
                  <option value="empty">비우기</option>
                </select>
              </label>
            )}
            {kind !== 'addSheet' &&
              !(kind === 'setCell' && valueType === 'empty') && (
                <label>
                  {kind === 'appendRows'
                    ? '행 데이터 (Excel에서 붙여넣기)'
                    : kind === 'setFormula'
                      ? '수식'
                      : '셀 값'}
                  <textarea
                    rows={kind === 'appendRows' ? 6 : 2}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                  />
                </label>
              )}
            {kind === 'appendRows' && (
              <label>
                열 구분
                <select
                  value={delimiter}
                  onChange={(event) =>
                    setDelimiter(event.target.value as typeof delimiter)
                  }
                >
                  <option value={'\t'}>탭 (Excel 붙여넣기)</option>
                  <option value=",">쉼표 (CSV)</option>
                </select>
              </label>
            )}
            <button
              type="button"
              disabled={busy || operations.length >= 500}
              onClick={() => {
                try {
                  setOperations((current) => [...current, currentOperation()])
                  setInputError('')
                } catch (cause) {
                  setInputError(
                    cause instanceof Error
                      ? cause.message
                      : '입력을 확인하세요.'
                  )
                }
              }}
            >
              편집 목록에 추가
            </button>
            {!!operations.length && (
              <ol className="workfolio-operation-list">
                {operations.map((operation, index) => (
                  <li key={index}>
                    <span>
                      {operation.kind} ·{' '}
                      {'sheet' in operation ? operation.sheet : operation.name}
                      {'cell' in operation ? `!${operation.cell}` : ''}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`편집 ${index + 1} 제거`}
                      onClick={() =>
                        setOperations((current) =>
                          current.filter((_, i) => i !== index)
                        )
                      }
                    >
                      제거
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        {inputError && (
          <p role="alert" className="workfolio-tool-error">
            {inputError}
          </p>
        )}
        <ToolButton busy={busy} disabled={disabled}>
          {mode === 'inspect' ? '조회' : '파일로 저장'}
        </ToolButton>
      </form>
      {inspection && (
        <section
          className="workfolio-spreadsheet-preview"
          aria-label="Excel 조회 결과"
        >
          <div className="workfolio-spreadsheet-preview__heading">
            <div>
              <h3>{inspection.selectedSheet ?? '통합 문서'}</h3>
              <p>
                {inspection.range ? `${inspection.range} 범위 · ` : ''}
                {inspection.cells.length}개 셀
              </p>
            </div>
            <span>수식 결과는 계산하지 않음</span>
          </div>
          <nav className="workfolio-sheet-tabs" aria-label="워크시트">
            {inspection.sheets.map((item) => (
              <button
                key={item.name}
                type="button"
                aria-pressed={inspection.selectedSheet === item.name}
                onClick={() => {
                  setSheet(item.name)
                  setSelectedCell('')
                  if (!fileId) return
                  void run('Excel 시트 조회', async () => {
                    const result = await officeApi.inspectSpreadsheet(
                      connection,
                      {
                        fileId,
                        sheet: item.name,
                        range
                      }
                    )
                    setInspection(result)
                    return undefined
                  })
                }}
              >
                {item.name}
                <small>
                  {item.rows}행 · {item.columns}열
                </small>
              </button>
            ))}
          </nav>
          {inspection.cells.length ? (
            <>
              <div
                className="workfolio-spreadsheet-formula-bar"
                aria-live="polite"
              >
                <strong>{selectedCell || '셀 선택'}</strong>
                <span>
                  {inspection.cells.find(
                    (cell) => cell.address === selectedCell
                  )?.formula
                    ? `=${inspection.cells.find((cell) => cell.address === selectedCell)?.formula}`
                    : String(
                        inspection.cells.find(
                          (cell) => cell.address === selectedCell
                        )?.value ?? ''
                      )}
                </span>
              </div>
              <div
                className="workfolio-spreadsheet-grid-scroll"
                role="region"
                aria-label="시트 셀 미리보기"
                tabIndex={0}
              >
                <table className="workfolio-spreadsheet-grid">
                  <colgroup>
                    <col style={{ width: 42 }} />
                    {previewGrid?.columnWidths.map((width, index) => (
                      <col key={previewGrid.columns[index]} style={{ width }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th aria-label="행 번호" />
                      {previewGrid?.columns.map((column) => (
                        <th key={column} scope="col">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewGrid?.rows.map((row) => (
                      <tr key={row.number}>
                        <th scope="row">{row.number}</th>
                        {row.cells.map((value, index) => {
                          const address = `${previewGrid?.columns[index]}${row.number}`
                          return (
                            <td key={address}>
                              <button
                                type="button"
                                aria-label={`${address}: ${value || '빈 셀'}`}
                                aria-pressed={selectedCell === address}
                                onClick={() => setSelectedCell(address)}
                              >
                                {value}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="workfolio-spreadsheet-empty">
              셀 데이터가 없어요. 시트를 선택하고 범위를 확인해 주세요.
            </p>
          )}
        </section>
      )}
    </>
  )
}
