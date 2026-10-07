import type { BackendArtifact } from '@/api/workroom'
import type { Task } from './types'

export function applySavedDocument(
  task: Task,
  artifact: BackendArtifact,
  submittedMarkdown: string
): Task {
  const unchangedDuringSave = task.document === submittedMarkdown

  return {
    ...task,
    savedDocument: artifact.content,
    documentDirty: !unchangedDuringSave || task.document !== artifact.content,
    artifactFileId: artifact.fileId,
    artifactName: artifact.name,
    artifactMimeType: artifact.mimeType
  }
}
