import { request, type Connection, type ManagedFile } from './workroom'

export type FileResult = { file: ManagedFile }
export type ExtractedDocument = {
  fileId: string
  fileName: string
  format: string
  text: string
  warnings: string[]
}
export type DocumentDiff = {
  added: string[]
  removed: string[]
  unchangedLines: number
}
export type Scalar = string | number | boolean | null
export type SpreadsheetOperation =
  | { kind: 'addSheet'; name: string }
  | { kind: 'setCell'; sheet: string; cell: string; value: Scalar }
  | { kind: 'setFormula'; sheet: string; cell: string; formula: string }
  | { kind: 'appendRows'; sheet: string; rows: Scalar[][] }
export type SpreadsheetInspection = {
  fileId: string
  selectedSheet?: string
  range?: string
  sheets: Array<{ name: string; rows: number; columns: number }>
  cells: Array<{ address: string; value: Scalar; formula?: string }>
  formulaCalculation: 'not-performed'
}
export type PdfInspection = {
  pageCount: number
  pages: Array<{
    number: number
    width: number
    height: number
    rotation: number
  }>
}
export type PdfThumbnailBatch = {
  pageCount: number
  pages: Array<{
    pageNumber: number
    width: number
    height: number
    dataBase64: string
  }>
}
export type BrowserResult = {
  sessionId: string
  title: string
  url: string
  text?: string
  screenshotBase64?: string
}
export type BrowserAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'extractText' }
  | { kind: 'screenshot' }
export type ComputerAction =
  | { kind: 'screenshot' }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'type'; text: string }
export type ComputerResult = {
  kind: string
  executed: boolean
  screenshotBase64?: string
}
export type WebSource = {
  title: string
  url: string
  snippet: string
  content: string
  retrievalStatus: 'retrieved' | 'unavailable'
  retrievedAt: string
}

function post<T>(
  connection: Connection,
  path: string,
  body: unknown
): Promise<T> {
  return request<T>(connection, path, {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export const officeApi = {
  search: (connection: Connection, query: string) =>
    post<{ items: WebSource[] }>(connection, '/api/search', {
      query,
      limit: 3
    }),
  listFiles: (connection: Connection, cursor?: string, search?: string) => {
    const query = new URLSearchParams({ limit: '100' })
    if (cursor) query.set('cursor', cursor)
    if (search) query.set('search', search)
    return request<{ items: ManagedFile[]; nextCursor?: string }>(
      connection,
      `/api/files?${query}`
    )
  },
  markdown: (
    connection: Connection,
    input: { outputName: string; markdown: string }
  ) => post<FileResult>(connection, '/api/documents/markdown', input),
  exportMarkdown: (
    connection: Connection,
    input: { outputName: string; markdown: string; format: 'xlsx' | 'pdf' }
  ) => post<FileResult>(connection, '/api/documents/export', input),
  extract: (connection: Connection, fileId: string) =>
    post<ExtractedDocument>(connection, '/api/documents/extract', { fileId }),
  compare: (connection: Connection, leftFileId: string, rightFileId: string) =>
    post<DocumentDiff>(connection, '/api/documents/compare', {
      leftFileId,
      rightFileId
    }),
  replace: (
    connection: Connection,
    input: {
      fileId: string
      outputName: string
      replacements: Array<{ find: string; replace: string }>
    }
  ) =>
    post<FileResult & { replacements: number; missing: string[] }>(
      connection,
      '/api/documents/replace-text',
      input
    ),
  template: (
    connection: Connection,
    input: {
      fileId: string
      outputName: string
      variables: Record<string, Scalar>
    }
  ) => post<FileResult>(connection, '/api/documents/template-fill', input),
  redact: (
    connection: Connection,
    input: {
      fileId: string
      outputName: string
      rules: Array<'email' | 'phone' | 'residentId'>
    }
  ) =>
    post<FileResult & { replacements: number }>(
      connection,
      '/api/documents/redact',
      input
    ),
  ai: (
    connection: Connection,
    input: {
      fileId: string
      outputName: string
      operation: 'summarize' | 'translate' | 'proofread' | 'rewrite'
      targetLanguage?: string
      instructions?: string
    }
  ) =>
    post<FileResult & { text: string }>(connection, '/api/documents/ai', input),
  spreadsheet: (
    connection: Connection,
    input: {
      fileId?: string
      outputName: string
      operations: SpreadsheetOperation[]
    }
  ) =>
    post<FileResult>(
      connection,
      `/api/spreadsheets/${input.fileId ? 'edit' : 'create'}`,
      input
    ),
  inspectSpreadsheet: (
    connection: Connection,
    input: { fileId: string; sheet?: string; range?: string }
  ) =>
    post<SpreadsheetInspection>(connection, '/api/spreadsheets/inspect', input),
  inspectPdf: (connection: Connection, fileId: string) =>
    post<PdfInspection>(connection, '/api/pdfs/inspect', { fileId }),
  pdfThumbnails: (
    connection: Connection,
    input: { fileId: string; pageNumbers: number[] }
  ) => post<PdfThumbnailBatch>(connection, '/api/pdfs/thumbnails', input),
  mergePdf: (
    connection: Connection,
    input: { fileIds: string[]; outputName: string }
  ) => post<FileResult>(connection, '/api/pdfs/merge', input),
  splitPdf: (
    connection: Connection,
    input: { fileId: string; pageNumbers: number[]; outputPrefix: string }
  ) => post<{ files: ManagedFile[] }>(connection, '/api/pdfs/split', input),
  editPdf: (
    connection: Connection,
    input: {
      fileId: string
      outputName: string
      operation: {
        kind: 'reorder' | 'removePages' | 'rotatePages'
        pageNumbers: number[]
        degrees?: number
      }
    }
  ) => post<FileResult>(connection, '/api/pdfs/edit', input),
  createBrowser: (connection: Connection, url?: string) =>
    post<BrowserResult>(connection, '/api/browser/sessions', { url }),
  browserAction: (
    connection: Connection,
    sessionId: string,
    action: BrowserAction
  ) =>
    post<BrowserResult>(
      connection,
      `/api/browser/sessions/${encodeURIComponent(sessionId)}/actions`,
      action
    ),
  closeBrowser: (connection: Connection, sessionId: string) =>
    request<void>(
      connection,
      `/api/browser/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' }
    ),
  computerAction: (connection: Connection, action: ComputerAction) =>
    post<ComputerResult>(connection, '/api/computer/actions', { action })
}
