import type { Task } from './types'

function key(taskId: string, backend: string) {
  return `workfolio-draft-v1:${backend}:${taskId}`
}

export function restoreDocumentDraft(
  task: Task,
  backend: string,
  storage: Pick<Storage, 'getItem'>
): Task {
  try {
    const draft: unknown = JSON.parse(
      storage.getItem(key(task.id, backend)) ?? 'null'
    )
    if (
      draft &&
      typeof draft === 'object' &&
      'document' in draft &&
      typeof draft.document === 'string' &&
      draft.document.length <= 200_000 &&
      draft.document !== task.savedDocument
    ) {
      return { ...task, document: draft.document, documentDirty: true }
    }
  } catch {
    /* A corrupt draft must never prevent the server document from opening. */
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
      JSON.stringify({ document: task.document })
    )
  else storage.removeItem(key(task.id, backend))
}
