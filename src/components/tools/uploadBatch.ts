import { MAX_SOURCE_FILE_BYTES, validateSourceFile } from '@/api/workroom'

export const MAX_BATCH_UPLOAD_FILES = 5
export const MAX_BATCH_UPLOAD_BYTES =
  MAX_SOURCE_FILE_BYTES * 2 + 5 * 1024 * 1024

export function validateUploadBatch(
  files: Array<Pick<File, 'name' | 'type' | 'size'>>
) {
  if (files.length > MAX_BATCH_UPLOAD_FILES) {
    throw new Error(
      `한 번에 최대 ${MAX_BATCH_UPLOAD_FILES}개 파일까지 업로드할 수 있습니다.`
    )
  }
  files.forEach(validateSourceFile)

  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  if (totalBytes > MAX_BATCH_UPLOAD_BYTES) {
    throw new Error('한 번에 업로드할 수 있는 파일의 합계는 25 MiB 이하입니다.')
  }
}
