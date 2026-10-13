import type { BackendArtifact } from '@/api/workroom'
import type { Task } from './types'

export function applySavedDocument(
  task: Task,
  artifact: BackendArtifact,
  submittedMarkdown: string
): Task {
  const unchangedDuringSave = task.document === submittedMarkdown
  const documentDirty =
    !unchangedDuringSave || task.document !== artifact.content

  return {
    ...task,
    savedDocument: artifact.content,
    documentDirty,
    documentDraftBase: documentDirty ? artifact.content : undefined,
    artifactFileId: artifact.fileId,
    artifactName: artifact.name,
    artifactMimeType: artifact.mimeType
  }
}
