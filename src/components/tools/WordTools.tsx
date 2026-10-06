'use client'

import React, { useState } from 'react'
import { officeApi } from '@/api/automation'
import { FileField, ToolButton, type ToolProps } from './ToolFields'

type Operation =
  | 'markdown'
  | 'extract'
  | 'replace'
  | 'template'
  | 'compare'
  | 'redact'
  | 'ai'
export default function WordTools({
  connection,
  files,
  filesLoading = false,
  busy,
  disabled,
  run
}: ToolProps) {
  const [operation, setOperation] = useState<Operation>('markdown')
  const [fileId, setFileId] = useState('')
  const [rightId, setRightId] = useState('')
  const [outputName, setOutputName] = useState('')
  const [text, setText] = useState('')
  const [find, setFind] = useState('')
  const [replacement, setReplacement] = useState('')
  const [aiOperation, setAiOperation] = useState<
    'summarize' | 'translate' | 'proofread' | 'rewrite'
  >('summarize')
  const [language, setLanguage] = useState('한국어')
  const [variables, setVariables] = useState([{ name: '', value: '' }])
  const [rules, setRules] = useState<Array<'email' | 'phone' | 'residentId'>>([
    'email',
    'phone',
    'residentId'
  ])
  const inputFiles = ['replace', 'template'].includes(operation)
    ? files.filter((file) => file.name.toLowerCase().endsWith('.docx'))
    : files
  const compareFiles = files.filter((file) => file.id !== fileId)
  const readyForRequiredFiles =
    operation === 'markdown' ||
    (inputFiles.length > 0 &&
      (operation !== 'compare' || files.length > 1))
  return (
    <form
      className="workfolio-tool-form"
      onSubmit={(event) => {
        event.preventDefault()
        void run('문서 작업', async () => {
          switch (operation) {
            case 'markdown':
              return officeApi.markdown(connection, {
                outputName,
                markdown: text
              })
            case 'extract':
              return officeApi.extract(connection, fileId)
            case 'compare':
              return officeApi.compare(connection, fileId, rightId)
            case 'replace':
              return officeApi.replace(connection, {
                fileId,
                outputName,
                replacements: [{ find, replace: replacement }]
              })
            case 'template': {
              const entries = variables
                .filter((item) => item.name.trim())
                .map((item) => [item.name.trim(), item.value] as const)
              if (
                !entries.length ||
                new Set(entries.map(([name]) => name)).size !== entries.length
              )
                throw new Error('중복 없이 템플릿 변수 이름과 값을 입력하세요.')
              return officeApi.template(connection, {
                fileId,
                outputName,
                variables: Object.fromEntries(entries)
              })
            }
            case 'redact':
              if (!rules.length) throw new Error('마스킹할 정보를 선택하세요.')
              return officeApi.redact(connection, { fileId, outputName, rules })
            case 'ai':
              return officeApi.ai(connection, {
                fileId,
                outputName,
                operation: aiOperation,
                targetLanguage: language,
                instructions: text
              })
          }
        })
      }}
    >
      <h2>문서 편집</h2>
      <p>
        원본은 보존하며 결과물을 새 파일로 저장합니다. 이미지 문서의 OCR과
        Google Docs 직접 연결은 지원하지 않습니다.
      </p>
      <label>
        작업
        <select
          value={operation}
          onChange={(event) => {
            setOperation(event.target.value as Operation)
            setFileId('')
          }}
        >
          <option value="markdown">Markdown으로 Word 생성</option>
          <option value="extract">문서 텍스트 추출</option>
          <option value="replace">Word 텍스트 찾기·바꾸기</option>
          <option value="template">Word 템플릿 채우기</option>
          <option value="compare">두 문서 비교</option>
          <option value="redact">개인정보 마스킹</option>
          <option value="ai">AI 요약·번역·교정</option>
        </select>
      </label>
      {operation !== 'markdown' && (
        <FileField
          files={inputFiles}
          value={fileId}
          onChange={setFileId}
          loading={filesLoading}
          emptyMessage={
            ['replace', 'template'].includes(operation)
              ? 'Word 문서(.docx)가 없습니다. 상단에서 DOCX 파일을 업로드해 주세요.'
              : '작업할 문서가 없습니다. 상단에서 문서 파일을 업로드해 주세요.'
          }
        />
      )}
      {operation === 'compare' && (
        <FileField
          files={compareFiles}
          value={rightId}
          onChange={setRightId}
          label="비교할 파일"
          loading={filesLoading}
          emptyMessage="비교할 두 번째 파일이 없습니다. 문서 파일을 하나 더 업로드해 주세요."
        />
      )}
      {!['extract', 'compare'].includes(operation) && (
        <label>
          결과 파일 이름
          <input
            required
            maxLength={150}
            value={outputName}
            onChange={(event) => setOutputName(event.target.value)}
            placeholder="확장자 없이 입력해도 됩니다"
          />
        </label>
      )}
      {(operation === 'markdown' || operation === 'ai') && (
        <label>
          {operation === 'markdown'
            ? '문서 내용 (Markdown)'
            : '추가 지시 (선택)'}
          <textarea
            rows={8}
            required={operation === 'markdown'}
            maxLength={200000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
      )}
      {operation === 'replace' && (
        <>
          <label>
            찾을 텍스트
            <input
              required
              value={find}
              onChange={(event) => setFind(event.target.value)}
            />
          </label>
          <label>
            바꿀 텍스트
            <input
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
            />
          </label>
        </>
      )}
      {operation === 'template' && (
        <fieldset>
          <legend>템플릿 변수</legend>
          <p>Word 문서의 {'{name}'} 표시에 대응하는 이름과 값을 입력하세요.</p>
          {variables.map((variable, index) => (
            <div className="workfolio-tool-row" key={index}>
              <input
                aria-label={`변수 ${index + 1} 이름`}
                required
                value={variable.name}
                onChange={(event) =>
                  setVariables((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, name: event.target.value } : item
                    )
                  )
                }
              />
              <input
                aria-label={`변수 ${index + 1} 값`}
                value={variable.value}
                onChange={(event) =>
                  setVariables((current) =>
                    current.map((item, i) =>
                      i === index
                        ? { ...item, value: event.target.value }
                        : item
                    )
                  )
                }
              />
              <button
                type="button"
                aria-label={`변수 ${index + 1} 삭제`}
                disabled={variables.length === 1}
                onClick={() =>
                  setVariables((current) =>
                    current.filter((_, i) => i !== index)
                  )
                }
              >
                삭제
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setVariables((current) => [...current, { name: '', value: '' }])
            }
          >
            변수 추가
          </button>
        </fieldset>
      )}
      {operation === 'redact' && (
        <fieldset>
          <legend>마스킹 대상</legend>
          {(
            [
              ['email', '이메일'],
              ['phone', '전화번호'],
              ['residentId', '주민등록번호']
            ] as const
          ).map(([rule, label]) => (
            <label className="workfolio-checkbox" key={rule}>
              <input
                type="checkbox"
                checked={rules.includes(rule)}
                onChange={(event) =>
                  setRules((current) =>
                    event.target.checked
                      ? [...current, rule]
                      : current.filter((item) => item !== rule)
                  )
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      {operation === 'ai' && (
        <>
          <label>
            AI 작업
            <select
              value={aiOperation}
              onChange={(event) =>
                setAiOperation(event.target.value as typeof aiOperation)
              }
            >
              <option value="summarize">요약</option>
              <option value="translate">번역</option>
              <option value="proofread">교정</option>
              <option value="rewrite">다시 쓰기</option>
            </select>
          </label>
          {aiOperation === 'translate' && (
            <label>
              번역 언어
              <input
                required
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              />
            </label>
          )}
          <p>설정된 모델 API를 사용하므로 비용이 발생할 수 있습니다.</p>
        </>
      )}
      <ToolButton busy={busy} disabled={disabled || !readyForRequiredFiles} />
    </form>
  )
}
