import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyDocumentCommand,
  getDocumentOutline,
  getDocumentSaveStatus,
  prepareFinalDocument
} from './documentModel.js'

test('preview and export omit request scaffolding while preserving document content', () => {
  const markdown = [
    '# 기능 점검 문서',
    '',
    '## 요청',
    '기능을 확인해 주세요.',
    '',
    '## 초안 구조 예시',
    '### 임시 구성',
    '내보내지 않을 안내입니다.',
    '',
    '## 점검 결과',
    '실제 문서 본문입니다.',
    '',
    '| 항목 | 상태 |',
    '| --- | --- |',
    '| 첨부 | 확인 |'
  ].join('\n')
  const finalDocument = prepareFinalDocument(markdown, '기능 점검 문서')
  assert.doesNotMatch(finalDocument, /기능을 확인|임시 구성|초안 구조|내보내지/)
  assert.match(finalDocument, /## 점검 결과\n실제 문서 본문입니다\./)
  assert.match(finalDocument, /\| 첨부 \| 확인 \|/)
  assert.equal(
    prepareFinalDocument(finalDocument, '기능 점검 문서'),
    finalDocument
  )
})

test('extractsOutlineAndOffsetsAcrossLineEndings', () => {
  const markdown = [
    '# Same',
    '## Same',
    '```md',
    '# ignored',
    '```',
    '### Third',
    '#### Fourth',
    '##### Fifth',
    '###### Sixth'
  ].join('\r\n')

  assert.deepEqual(getDocumentOutline(markdown), [
    { level: 1, title: 'Same', line: 1, start: 0 },
    { level: 2, title: 'Same', line: 2, start: markdown.indexOf('## Same') },
    { level: 3, title: 'Third', line: 6, start: markdown.indexOf('### Third') },
    {
      level: 4,
      title: 'Fourth',
      line: 7,
      start: markdown.indexOf('#### Fourth')
    },
    {
      level: 5,
      title: 'Fifth',
      line: 8,
      start: markdown.indexOf('##### Fifth')
    },
    {
      level: 6,
      title: 'Sixth',
      line: 9,
      start: markdown.indexOf('###### Sixth')
    }
  ])
})

test('ignoresHeadingsInsideFencedCodeBlocks', () => {
  assert.deepEqual(getDocumentOutline('```md\n# hidden\n```\n# Visible'), [
    { level: 1, title: 'Visible', line: 4, start: 19 }
  ])
})

test('returnsNoOutlineWithoutHeadings', () => {
  assert.deepEqual(getDocumentOutline('A paragraph\nwith two lines.'), [])
})

test('appliesMarkdownCommandsAndPreservesSelection', () => {
  assert.deepEqual(applyDocumentCommand('plain text\nkeep', 6, 6, 'heading1'), {
    value: '# plain text\nkeep',
    selectionStart: 8,
    selectionEnd: 8
  })
  assert.deepEqual(applyDocumentCommand('### title', 5, 5, 'heading2'), {
    value: '## title',
    selectionStart: 4,
    selectionEnd: 4
  })
  assert.deepEqual(applyDocumentCommand('alpha beta', 2, 5, 'bold'), {
    value: 'al**pha** beta',
    selectionStart: 4,
    selectionEnd: 7
  })
  assert.deepEqual(applyDocumentCommand('first\nsecond', 0, 12, 'bullet'), {
    value: '- first\n- second',
    selectionStart: 2,
    selectionEnd: 16
  })
  assert.deepEqual(applyDocumentCommand('first\nsecond', 0, 12, 'quote'), {
    value: '> first\n> second',
    selectionStart: 2,
    selectionEnd: 16
  })
})

test('placesCaretInsideEmptyBoldMarkers', () => {
  assert.deepEqual(applyDocumentCommand('word', 2, 2, 'bold'), {
    value: 'wo****rd',
    selectionStart: 4,
    selectionEnd: 4
  })
})

test('saveStatePrioritizesErrorAndDirtyContent', () => {
  assert.equal(
    getDocumentSaveStatus({ dirty: false, saving: false, error: 'offline' }),
    'error'
  )
  assert.equal(
    getDocumentSaveStatus({ dirty: true, saving: true, error: null }),
    'saving'
  )
  assert.equal(
    getDocumentSaveStatus({ dirty: true, saving: false, error: null }),
    'unsaved'
  )
  assert.equal(
    getDocumentSaveStatus({ dirty: false, saving: false, error: null }),
    'saved'
  )
})
