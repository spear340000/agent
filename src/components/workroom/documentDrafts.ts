import type { Task } from './types'

function key(taskId: string, backend: string) {
  return `workfolio-draft-v1:${backend}:${taskId}`
}

export function restoreDocumentDraft(
  task: Task,
  backend: string,
  storage: Pick<Storage, 'getItem' | 'removeItem'>
): Task {
  const draftKey = key(task.id, backend)
  try {
    const draft: unknown = JSON.parse(storage.getItem(draftKey) ?? 'null')
    if (
      draft &&
      typeof draft === 'object' &&
      'document' in draft &&
      typeof draft.document === 'string' &&
      draft.document.length <= 200_000
    ) {
      const savedDocument = task.savedDocument ?? ''
      const document = draft.document
      const baseDocument =
        'baseDocument' in draft && typeof draft.baseDocument === 'string'
          ? draft.baseDocument
          : undefined
      if (document === savedDocument) {
        storage.removeItem(draftKey)
        return task
      }
      if (baseDocument === savedDocument) {
        return {
          ...task,
          document,
          documentDirty: true,
          documentDraftBase: baseDocument
        }
      }
      return { ...task, documentDraftConflict: document }
    }
    if (draft !== null) storage.removeItem(draftKey)
  } catch {
    /* A corrupt draft must never prevent the server document from opening. */
    try {
      storage.removeItem(draftKey)
    } catch {
      /* Storage cleanup is best-effort. */
    }
  }
  return task
}

export function persistDocumentDraft(
  task: Task,
  backend: string,
  storage: Pick<Storage, 'setItem' | 'removeItem'>
) {
  if (task.documentDirty)
    storage.setItem(
      key(task.id, backend),
      JSON.stringify({
        document: task.document,
        baseDocument: task.documentDraftBase ?? task.savedDocument ?? ''
      })
    )
  else storage.removeItem(key(task.id, backend))
}

export function clearDocumentDraft(
  taskId: string,
  backend: string,
  storage: Pick<Storage, 'removeItem'>
) {
  storage.removeItem(key(taskId, backend))
}
