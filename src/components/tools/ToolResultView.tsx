import React from 'react'
import { downloadFile, type Connection, type ManagedFile } from '@/api/workroom'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}
export default function ToolResultView({
  result,
  connection,
  onError
}: {
  result: unknown
  connection: Connection
  onError: (message: string) => void
}) {
  const value = record(result)
  const outputFiles = [
    value.file,
    ...(Array.isArray(value.files) ? value.files : [])
  ].filter(
    (file): file is ManagedFile =>
      !!file &&
      typeof file === 'object' &&
      'id' in file &&
      'name' in file &&
      typeof file.id === 'string' &&
      typeof file.name === 'string'
  )
  const text = typeof value.text === 'string' ? value.text : ''
  const image =
    typeof value.screenshotBase64 === 'string' ? value.screenshotBase64 : ''
  const added = Array.isArray(value.added)
    ? value.added.filter((item): item is string => typeof item === 'string')
    : []
  const removed = Array.isArray(value.removed)
    ? value.removed.filter((item): item is string => typeof item === 'string')
    : []
  const warnings = [
    ...(Array.isArray(value.warnings) ? value.warnings : []),
    ...(Array.isArray(value.missing)
      ? value.missing.map((item) => `찾지 못한 텍스트: ${String(item)}`)
      : [])
  ].filter((item): item is string => typeof item === 'string')
  return (
    <section
      className="workfolio-tool-result"
      aria-label="작업 결과"
      aria-live="polite"
    >
      <h2>작업 결과</h2>
      {!!outputFiles.length && (
        <ul>
          {outputFiles.map((file) => (
            <li key={file.id}>
              <span>{file.name}</span>
              <button
                type="button"
                onClick={() =>
                  void downloadFile(file.id, file.name, connection).catch(
                    (cause) =>
                      onError(
                        cause instanceof Error ? cause.message : '다운로드 실패'
                      )
                  )
                }
              >
                다운로드
              </button>
            </li>
          ))}
        </ul>
      )}
      {typeof value.replacements === 'number' && (
        <p>변경된 항목: {value.replacements}개</p>
      )}
      {warnings.map((warning, index) => (
        <p className="workfolio-tool-warning" key={index}>
          {warning}
        </p>
      ))}
      {text && <pre>{text}</pre>}
      {!!added.length && (
        <div>
          <h3>추가된 내용</h3>
          <pre>{added.join('\n')}</pre>
        </div>
      )}
      {!!removed.length && (
        <div>
          <h3>삭제된 내용</h3>
          <pre>{removed.join('\n')}</pre>
        </div>
      )}
      {typeof value.unchangedLines === 'number' && (
        <p>동일한 줄: {value.unchangedLines}</p>
      )}
      {image && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- Live data-URL screenshots keep their original dimensions. */}
          <img
            alt="실제 자동화 작업 화면"
            src={`data:image/png;base64,${image}`}
          />
        </>
      )}
      {!outputFiles.length &&
        !text &&
        !image &&
        !added.length &&
        !removed.length && (
          <p>요청이 완료되었습니다. 조회 결과는 도구 화면에 표시됩니다.</p>
        )}
    </section>
  )
}
