import React from 'react'
import type { Connection, ManagedFile } from '@/api/workroom'

export type RunTool = <T>(
  label: string,
  operation: () => Promise<T>
) => Promise<T | undefined>
export type ToolProps = {
  connection: Connection
  files: ManagedFile[]
  busy: boolean
  disabled?: boolean
  run: RunTool
}

export function FileField({
  files,
  value,
  onChange,
  label = '원본 파일',
  required = true,
  multiple = false
}: {
  files: ManagedFile[]
  value: string | string[]
  onChange: (value: string) => void
  label?: string
  required?: boolean
  multiple?: boolean
}) {
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
