import React from 'react'
import type { Connection, ManagedFile } from '@/api/workroom'

export type RunTool = <T>(
  label: string,
  operation: () => Promise<T>
) => Promise<T | undefined>
export type ToolProps = {
  connection: Connection
  files: ManagedFile[]
  filesLoading?: boolean
  busy: boolean
  disabled?: boolean
  run: RunTool
}

export function FileField({
  files,
  value,
  onChange,
  label = '원본 파일',
  emptyMessage = '작업에 필요한 파일이 없습니다. 상단에서 파일을 업로드해 주세요.',
  loading = false,
  required = true,
  multiple = false
}: {
  files: ManagedFile[]
  value: string | string[]
  onChange: (value: string) => void
  label?: string
  emptyMessage?: string
  loading?: boolean
  required?: boolean
  multiple?: boolean
}) {
  if (!files.length)
    return (
      <div className="workfolio-file-field">
        <span>{label}</span>
        <p role="status">
          {loading ? '파일 목록을 불러오는 중입니다.' : emptyMessage}
        </p>
      </div>
    )

  return (
    <label>
      {label}
      <select
        required={required}
        multiple={multiple}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {!multiple && <option value="">파일 선택</option>}
        {files.map((file) => (
          <option key={file.id} value={file.id}>
            {file.name}
          </option>
        ))}
      </select>
    </label>
  )
}

export function ToolButton({
  busy,
  disabled = false,
  children = '실행'
}: {
  busy: boolean
  disabled?: boolean
  children?: React.ReactNode
}) {
  return (
    <button
      className="workfolio-primary"
      type="submit"
      disabled={busy || disabled}
    >
      {busy ? '처리 중…' : children}
    </button>
  )
}
