import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearDocumentDraft,
  persistDocumentDraft,
  restoreDocumentDraft
} from './documentDrafts'
import type { Task } from './types'

test('unsaved documents survive reload and are isolated by backend; saved drafts are removed', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  }
  const task: Task = {
    id: 'task_1',
    title: '문서',
    request: '',
    sources: [],
    messages: [],
    stage: 'completed',
    steps: [],
    state: 'completed',
    document: '수동 초안',
    savedDocument: '서버 버전',
    documentDirty: true,
    documentType: 'md',
    createdAt: 0,
    updatedAt: 0
  }
  persistDocumentDraft(task, 'http://127.0.0.1:8787', storage)
  const server = { ...task, document: '서버 버전', documentDirty: false }
  assert.equal(
    restoreDocumentDraft(server, 'http://127.0.0.1:8787', storage).document,
    '수동 초안'
  )
  assert.equal(
    restoreDocumentDraft(server, 'http://different-server', storage).document,
    '서버 버전'
  )
  persistDocumentDraft(
    { ...task, documentDirty: false },
    'http://127.0.0.1:8787',
    storage
  )
  assert.equal(
    restoreDocumentDraft(server, 'http://127.0.0.1:8787', storage)
      .documentDirty,
    false
  )
})

test('a server change leaves the local draft available as an explicit conflict', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  }
  const task: Task = {
    id: 'task_2',
    title: 'Document',
    request: '',
    sources: [],
    messages: [],
    stage: 'completed',
    steps: [],
    state: 'completed',
    document: 'local edit',
    savedDocument: 'server version 1',
    documentDirty: true,
    documentType: 'md',
    createdAt: 0,
    updatedAt: 0
  }

  persistDocumentDraft(
    {
      ...task,
      savedDocument: 'server version 2',
      documentDraftBase: 'server version 1'
    },
    'http://127.0.0.1:8787',
    storage
  )
  const newerServer = {
    ...task,
    document: 'server version 2',
    savedDocument: 'server version 2',
    documentDirty: false
  }

  const restored = restoreDocumentDraft(
    newerServer,
    'http://127.0.0.1:8787',
    storage
  )
  assert.equal(restored.document, 'server version 2')
  assert.equal(restored.documentDraftConflict, 'local edit')
  assert.equal(values.size, 1)

  clearDocumentDraft('task_2', 'http://127.0.0.1:8787', storage)
  assert.equal(values.size, 0)
})
