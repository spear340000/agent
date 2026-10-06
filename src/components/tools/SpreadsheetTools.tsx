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

function serializeRows(rows: Scalar[][], delimiter: ',' | '\t'): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const text = cell == null ? '' : String(cell)
          return /["\r\n]/.test(text) || text.includes(delimiter)
            ? `"${text.replace(/"/g, '""')}"`
            : text
        })
        .join(delimiter)
    )
    .join('\n')
}

function operationSummary(operation: SpreadsheetOperation): {
  title: string
  detail: string
} {
  switch (operation.kind) {
    case 'addSheet':
      return { title: '시트 추가', detail: operation.name }
    case 'setCell':
      return {
        title: operation.value === null ? '셀 비우기' : '셀 값 변경',
        detail: `${operation.sheet}!${operation.cell} · ${String(operation.value ?? '빈 셀')}`
      }
    case 'setFormula':
      return {
        title: '수식 입력',
        detail: `${operation.sheet}!${operation.cell} · =${operation.formula}`
      }
    case 'appendRows':
      return {
        title: '행 추가',
        detail: `${operation.sheet} · ${operation.rows.length}행, ${operation.rows[0]?.length ?? 0}열`
      }
  }
}

export default function SpreadsheetTools({
  connection,
  files,
  filesLoading = false,
  busy,
  disabled,
  run
}: ToolProps) {
  const [mode, setMode] = useState<'inspect' | 'create' | 'edit'>('inspect')
  const [fileId, setFileId] = useState('')
  const [outputName, setOutputName] = useState('')
  const [sheet, setSheet] = useState('')
  const [range, setRange] = useState('A1:Z50')
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
  const [queueWasCleared, setQueueWasCleared] = useState(false)
  const [editingOperationIndex, setEditingOperationIndex] = useState<
    number | null
  >(null)
  const [pendingSwitch, setPendingSwitch] = useState<
    | { kind: 'mode'; value: typeof mode }
    | { kind: 'file'; value: string }
    | null
  >(null)
  const [inputError, setInputError] = useState('')
  const excelFiles = files.filter((file) =>
    file.name.toLowerCase().endsWith('.xlsx')
  )

  function changeMode(next: typeof mode) {
    setMode(next)
    setOperations([])
    setQueueWasCleared(false)
    setEditingOperationIndex(null)
    setKind(next === 'create' ? 'addSheet' : 'setCell')
    setInspection(null)
    setPendingSwitch(null)
  }

  function changeFile(next: string) {
    setFileId(next)
    setInspection(null)
    setOperations([])
    setQueueWasCleared(false)
    setEditingOperationIndex(null)
    setPendingSwitch(null)
  }

  function requestSwitch(next: NonNullable<typeof pendingSwitch>) {
    if (operations.length > 0) setPendingSwitch(next)
    else if (next.kind === 'mode') changeMode(next.value)
    else changeFile(next.value)
  }

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
    <form
      className="workfolio-tool-form"
      onSubmit={(event) => {
        event.preventDefault()
        setInputError('')
        void run('Excel 작업', async () => {
          if (mode === 'inspect') {
            const result = await officeApi.inspectSpreadsheet(connection, {
              fileId,
              ...(sheet.trim() ? { sheet: sheet.trim(), range } : {})
            })
            setInspection(result)
            return result
          }
          const pending =
            editingOperationIndex === null
              ? operations.length
                ? operations
                : [currentOperation()]
              : operations.map((operation, index) =>
                  index === editingOperationIndex
                    ? currentOperation()
                    : operation
                )
          if (mode === 'create' && pending[0]?.kind !== 'addSheet')
            throw new Error('새 Excel은 시트 추가 작업부터 시작하세요.')
          const result = await officeApi.spreadsheet(connection, {
            fileId: mode === 'edit' ? fileId : undefined,
            outputName,
            operations: pending
          })
          setOperations([])
          setQueueWasCleared(true)
          setEditingOperationIndex(null)
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
            requestSwitch({ kind: 'mode', value: next })
          }}
        >
          <option value="inspect">시트·셀 조회</option>
          <option value="create">새 Excel 생성</option>
          <option value="edit">기존 Excel 편집</option>
        </select>
      </label>
      {mode !== 'create' && (
        <FileField
          files={excelFiles}
          value={fileId}
          loading={filesLoading}
          emptyMessage="Excel 통합 문서(.xlsx)가 없습니다. 상단에서 .xlsx 파일을 업로드해 주세요."
          onChange={(id) => {
            requestSwitch({ kind: 'file', value: id })
          }}
        />
      )}
      {pendingSwitch && (
        <div
          className="workfolio-operation-switch"
          role="group"
          aria-label="변경 목록 전환 확인"
        >
          <p>
            변경 목록 {operations.length}개가 있습니다.{' '}
            {pendingSwitch.kind === 'mode' ? '작업 방식을' : '파일을'} 바꾸면
            목록이 삭제됩니다.
          </p>
          <div>
            <button type="button" onClick={() => setPendingSwitch(null)}>
              계속 편집
            </button>
            <button
              type="button"
              onClick={() =>
                pendingSwitch.kind === 'mode'
                  ? changeMode(pendingSwitch.value)
                  : changeFile(pendingSwitch.value)
              }
            >
              목록 삭제하고 전환
            </button>
          </div>
        </div>
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
        {mode === 'inspect' ? '시트 이름 (비우면 전체 시트 조회)' : '시트 이름'}
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
            placeholder="A1:Z50"
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
            disabled={
              busy ||
              (operations.length >= 500 && editingOperationIndex === null)
            }
            onClick={() => {
              try {
                const nextOperation = currentOperation()
                setOperations((current) =>
                  editingOperationIndex === null
                    ? [...current, nextOperation]
                    : current.map((operation, index) =>
                        index === editingOperationIndex
                          ? nextOperation
                          : operation
                      )
                )
                setQueueWasCleared(false)
                setEditingOperationIndex(null)
                setInputError('')
              } catch (cause) {
                setInputError(
                  cause instanceof Error ? cause.message : '입력을 확인하세요.'
                )
              }
            }}
          >
            {editingOperationIndex === null ? '편집 목록에 추가' : '변경 저장'}
          </button>
          {editingOperationIndex !== null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditingOperationIndex(null)
                setInputError('')
              }}
            >
              취소
            </button>
          )}
          {!!operations.length && (
            <section
              className="workfolio-operation-queue"
              aria-label="Excel 변경 목록"
            >
              <header>
                <h3>
                  변경 목록 <span>{operations.length}</span>
                </h3>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setOperations([])
                    setEditingOperationIndex(null)
                    setQueueWasCleared(true)
                    setInputError('')
                  }}
                >
                  전체 비우기
                </button>
              </header>
              <ol className="workfolio-operation-list">
                {operations.map((operation, index) => {
                  const summary = operationSummary(operation)
                  return (
                    <li
                      key={index}
                      className={
                        editingOperationIndex === index ? 'is-editing' : ''
                      }
                    >
                      <div className="workfolio-operation-list__description">
                        <strong>
                          {index + 1}. {summary.title}
                        </strong>
                        <small>{summary.detail}</small>
                      </div>
                      <div className="workfolio-operation-list__actions">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditingOperationIndex(index)
                            setSheet(
                              'sheet' in operation
                                ? operation.sheet
                                : operation.name
                            )
                            setKind(operation.kind)
                            setInputError('')
                            if (operation.kind === 'setCell') {
                              setCell(operation.cell)
                              const nextValueType =
                                operation.value === null
                                  ? 'empty'
                                  : typeof operation.value === 'number'
                                    ? 'number'
                                    : typeof operation.value === 'boolean'
                                      ? 'boolean'
                                      : 'text'
                              setValueType(nextValueType)
                              setValue(
                                operation.value == null
                                  ? ''
                                  : String(operation.value)
                              )
                            } else if (operation.kind === 'setFormula') {
                              setCell(operation.cell)
                              setValue(operation.formula)
                            } else if (operation.kind === 'appendRows') {
                              setDelimiter('\t')
                              setValue(serializeRows(operation.rows, '\t'))
                            } else {
                              setValue('')
                            }
                          }}
                        >
                          수정
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`변경 ${index + 1} 삭제`}
                          onClick={() => {
                            if (operations.length === 1)
                              setQueueWasCleared(true)
                            setOperations((current) =>
                              current.filter(
                                (_, itemIndex) => itemIndex !== index
                              )
                            )
                            setEditingOperationIndex((current) =>
                              current === index
                                ? null
                                : current !== null && current > index
                                  ? current - 1
                                  : current
                            )
                          }}
                        >
                          삭제
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </section>
          )}
          {queueWasCleared && !operations.length && (
            <p className="workfolio-operation-queue__empty" role="status">
              변경 목록이 비었습니다. 파일로 저장하려면 변경 내용을 목록에
              추가하세요.
            </p>
          )}
        </>
      )}
      {inputError && (
        <p role="alert" className="workfolio-tool-error">
          {inputError}
        </p>
      )}
      <ToolButton
        busy={busy}
        disabled={
          disabled ||
          (mode !== 'create' && !excelFiles.length) ||
          editingOperationIndex !== null ||
          (queueWasCleared && !operations.length)
        }
      >
        {mode === 'inspect' ? '조회' : '파일로 저장'}
      </ToolButton>
      {inspection && (
        <section className="workfolio-table-wrap" aria-label="Excel 조회 결과">
          <table>
            <thead>
              <tr>
                <th>시트</th>
                <th>행</th>
                <th>열</th>
              </tr>
            </thead>
            <tbody>
              {inspection.sheets.map((item) => (
                <tr key={item.name}>
                  <td>
                    <button type="button" onClick={() => setSheet(item.name)}>
                      {item.name}
                    </button>
                  </td>
                  <td>{item.rows}</td>
                  <td>{item.columns}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!inspection.cells.length && (
            <table>
              <thead>
                <tr>
                  <th>셀</th>
                  <th>값</th>
                  <th>수식</th>
                </tr>
              </thead>
              <tbody>
                {inspection.cells.map((item) => (
                  <tr key={item.address}>
                    <td>{item.address}</td>
                    <td>{String(item.value ?? '')}</td>
                    <td>{item.formula ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </form>
  )
}
