import assert from 'node:assert/strict'
import test from 'node:test'
import { applySavedDocument } from './documentSave.js'
import type { BackendArtifact } from '@/api/workroom'
import type { Task } from './types.js'

const artifact: BackendArtifact = {
  id: 'artifact_saved',
  taskId: 'task_1',
  name: '보고서.md',
  kind: 'document',
  mimeType: 'text/markdown',
  content: '# 저장된 문서',
  fileId: 'file_saved',
  createdAt: '2026-09-29T00:10:00.000Z'
}

function task(document: string): Task {
  return {
    id: 'task_1',
    title: '보고서',
    request: '보고서를 작성해 주세요.',
    sources: [],
    messages: [],
    stage: 'completed',
    steps: [],
    state: 'completed',
    document,
    savedDocument: '',
    documentDirty: true,
    documentType: 'md',
    createdAt: 1,
    updatedAt: 2
  }
}

test('marks the exact server-persisted snapshot clean and records its artifact', () => {
  const saved = applySavedDocument(
    task('# 저장된 문서'),
    artifact,
    '# 저장된 문서'
  )

  assert.equal(saved.documentDirty, false)
  assert.equal(saved.savedDocument, '# 저장된 문서')
  assert.equal(saved.artifactFileId, 'file_saved')
  assert.equal(saved.artifactName, '보고서.md')
})

test('keeps edits made during the save dirty while recording the saved snapshot', () => {
  const saved = applySavedDocument(
    task('# 저장 후 추가 편집'),
    artifact,
    '# 저장된 문서'
  )

  assert.equal(saved.document, '# 저장 후 추가 편집')
  assert.equal(saved.documentDirty, true)
  assert.equal(saved.savedDocument, '# 저장된 문서')
})
