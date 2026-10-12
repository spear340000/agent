export const DEFAULT_BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL?.trim() || 'http://127.0.0.1:8787'
export const MAX_SOURCE_FILE_BYTES = 10 * 1024 * 1024

export type Connection = { baseUrl: string; token: string }
export type BackendTask = {
  id: string
  title: string
  prompt: string
  sourceFileIds: string[]
  sourceUrls: string[]
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  workflow?: 'legal' | 'document'
  steps: Array<{
    id: string
    title: string
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
    progress: number
    error?: string
  }>
  createdAt: string
  updatedAt: string
  error?: string
}
export type BackendArtifact = {
  id: string
  taskId: string
  name: string
  kind: 'document' | 'data'
  mimeType: string
  content: string
  fileId?: string
  createdAt: string
}
export type BackendEvent = {
  id: number
  taskId: string
  type: string
  title: string
  message: string
  status: string
  createdAt: string
  metadata?: Record<string, unknown>
}
export type TaskDetails = {
  task: BackendTask
  events: BackendEvent[]
  artifacts: BackendArtifact[]
}
export type ManagedFile = {
  id: string
  name: string
  mimeType: string
  bytes: number
  createdAt: string
}
export type RuntimeCapabilities = {
  model: { configured: boolean; provider: string | null }
  browserUse: { available: boolean }
  computerUse: { available: boolean; platform: string }
  legalRetrieval: LegalRetrievalCapability
  office: {
    docx: boolean
    xlsx: boolean
    pdf: boolean
    ocr: boolean
    googleDocs: boolean
    googleSheets: boolean
    formulaCalculation: boolean
  }
}
export type LegalRetrievalCapability = {
  enabled: boolean
  ready: boolean
  root: string
  corpus: {
    laws: number | null
    precedents: number | null
    graphNodes: number | null
    graphEdges: number | null
  }
  vector: { ready: boolean; reason?: string }
  ontology: { ready: boolean }
  okf: { ready: boolean }
  degraded: string[]
  state: 'ready' | 'degraded' | 'unavailable' | 'disabled' | 'unknown'
  message: string
}
export type LegalCitation = {
  citationId: string
  recordId: string
  corpus: 'law' | 'precedent' | 'graph' | 'document' | 'web'
  label: string
  officialUrl?: string
  indexPath?: string
  relatedArticles?: string[]
  statusMarkers?: string[]
  termMatches?: string[]
  relevance?: number
  date?: { kind: 'amendment' | 'decision'; value: string }
  provenance?: string[]
}
export type LegalLibraryItem = {
  citationId: string
  kind: 'law' | 'law-article' | 'precedent' | 'graph' | 'document' | 'web'
  corpus: 'law' | 'precedent' | 'graph' | 'document' | 'web'
  recordId: string
  title: string
  excerpt: string
  lawName?: string
  articleNumber?: string
  articleLabel?: string
  caseNumber?: string
  precedentSerial?: string
  caseName?: string
  court?: string
  officialUrl?: string
  indexPath?: string
  relatedArticles?: string[]
  statusMarkers?: string[]
  termMatches?: string[]
  relevance?: number
  graphRelation?: {
    sourceId: string
    sourceLabel: string
    sourceType: string
    relation: string
    targetId: string
    targetLabel: string
    targetType: string
    sourcePath?: string
    targetPath?: string
  }
  date?: { kind: 'amendment' | 'decision'; value: string }
}

export function searchLegalLibrary(
  query: string,
  corpus: 'law' | 'precedent' | 'graph' | 'all',
  connection: Connection = defaultConnection,
  limit = corpus === 'law' || corpus === 'all'
    ? 20
    : corpus === 'graph'
      ? 30
      : 10,
  fetcher: Fetcher = fetch
): Promise<{
  query: string
  corpus: 'law' | 'precedent' | 'graph' | 'all'
  items: LegalLibraryItem[]
}> {
  const params = new URLSearchParams({ q: query, corpus, limit: String(limit) })
  return request(
    connection,
    `/api/legal/library?${params.toString()}`,
    {},
    fetcher
  )
}

export function getLegalPrecedent(
  identifier: string,
  offset = 0,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<{
  item: LegalLibraryItem
  paging: { offset?: number; total?: number; hasMore?: boolean }
  nextOffset: number
}> {
  const params = new URLSearchParams({ identifier, offset: String(offset) })
  return request(
    connection,
    `/api/legal/precedent?${params.toString()}`,
    {},
    fetcher
  )
}

export type LegalMcpTool = {
  name: string
  description: string
  inputSchema?: unknown
}
export type LegalCatalogEntry = { name: string; content: string }
export type LegalWikiPageSummary = {
  name: string
  title: string
  bytes: number
}
export type LegalWikiPageChunk = {
  name: string
  content: string
  offset: number
  nextOffset: number
  totalCharacters: number
  hasMore: boolean
}

export function listLegalTools(
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<{ items: LegalMcpTool[] }> {
  return request(connection, '/api/legal/tools', {}, fetcher)
}

export function getLegalCatalog(
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<{ items: LegalCatalogEntry[] }> {
  return request(connection, '/api/legal/catalog', {}, fetcher)
}

export function listLegalWikiPages(
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<{ items: LegalWikiPageSummary[] }> {
  return request(connection, '/api/legal/wiki', {}, fetcher)
}

export function getLegalWikiPage(
  name: string,
  offset = 0,
  limit = 12_000,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<LegalWikiPageChunk> {
  const params = new URLSearchParams({
    name,
    offset: String(offset),
    limit: String(limit)
  })
  return request(
    connection,
    `/api/legal/wiki/page?${params.toString()}`,
    {},
    fetcher
  )
}
export type LegalLayerUse = {
  id:
    | 'law-keyword'
    | 'precedent-keyword'
    | 'vector'
    | 'graph'
    | 'ontology'
    | 'okf'
    | 'wiki'
  label: string
  state: 'used' | 'ready' | 'degraded' | 'unused' | 'unavailable'
  detail: string
}
export type LegalToolUse = {
  tool: string
  label: string
  query: string
  results: number
}
export type LegalLedger = {
  layers: LegalLayerUse[]
  tools: LegalToolUse[]
  toolCalls: number
  maxToolCalls: number
  planner: { calls: number; mode: 'not-used' | 'used' }
}
export type LegalSourceStatus = {
  corpusReady: boolean
  retrieved: number
  cited?: number
  degraded: string[]
  currentness: 'unverified' | 'record-dated'
  notes: string[]
  failures: { step: string; kind: string; message: string }[]
  ledger?: LegalLedger
  chain?: LegalChainStage[]
}
export type LegalChainStage = {
  id: 'wiki' | 'rag' | 'graph' | 'ontology' | 'okf' | 'mcp' | 'agent'
  label: string
  summary: string
  items: string[]
}
export type LegalAnswer = {
  intent: string
  path: 'direct' | 'orchestrated'
  answer: string
  citations: LegalCitation[]
  sourceStatus: LegalSourceStatus
  plannerCalls: number
  toolCalls: number
  artifactId?: string
  fileId?: string
}

export const defaultConnection: Connection = {
  baseUrl: DEFAULT_BACKEND_URL,
  token: ''
}

type Fetcher = typeof fetch
type JsonError = { error?: string; message?: string }
const FILE_DOWNLOAD_TIMEOUT_MS = 120_000
const fileMimeTypes: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv'
}

export function backendUrl(connection: Connection, path: string): string {
  let base: URL
  try {
    base = new URL(connection.baseUrl.trim())
  } catch {
    throw new Error('백엔드 주소를 확인해 주세요.')
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('백엔드 주소는 HTTP 또는 HTTPS 주소여야 합니다.')
  }
  return `${base.toString().replace(/\/$/, '')}${path}`
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function request<T>(
  connection: Connection,
  path: string,
  options: RequestInit = {},
  fetcher: Fetcher = fetch
): Promise<T> {
  const url = backendUrl(connection, path)
  const headers = new Headers(options.headers)
  if (connection.token.trim()) {
    headers.set('Authorization', `Bearer ${connection.token.trim()}`)
  }
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  let response: Response
  const timeout = AbortSignal.timeout(
    options.method === 'POST'
      ? 120_000
      : path === '/api/capabilities'
        ? 45_000
        : 15_000
  )
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout
  try {
    response = await fetcher(url, {
      ...options,
      headers,
      cache: 'no-store',
      signal
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new ApiError(
      timeout.aborted
        ? '백엔드 응답 시간이 초과되었습니다. 서버 상태를 확인해 주세요.'
        : '백엔드에 연결할 수 없습니다. 주소와 서버 실행 상태를 확인해 주세요.',
      0
    )
  }
  const body = await response.text()
  let payload: unknown
  try {
    payload = body ? JSON.parse(body) : undefined
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const error = payload as JsonError | undefined
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(
        error?.error || '인증 또는 백엔드 접근이 거부되었습니다.',
        response.status
      )
    }
    throw new ApiError(
      error?.error ||
        error?.message ||
        `백엔드 요청에 실패했습니다. (${response.status})`,
      response.status
    )
  }
  if (response.status === 204) return undefined as T
  if (payload === undefined) throw new Error('백엔드 응답을 읽을 수 없습니다.')
  return payload as T
}

export async function checkConnection(
  connection: Connection,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
): Promise<RuntimeCapabilities> {
  await request<{ ok: boolean }>(connection, '/health', { signal }, fetcher)
  return request<RuntimeCapabilities>(
    connection,
    '/api/capabilities',
    { signal },
    fetcher
  )
}

export function listTasks(
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<{ items: BackendTask[] }> {
  return request(connection, '/api/tasks', {}, fetcher)
}

export function getTaskDetails(
  id: string,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
): Promise<TaskDetails> {
  return request(
    connection,
    `/api/tasks/${encodeURIComponent(id)}`,
    { signal },
    fetcher
  )
}

export function getFile(
  id: string,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<{ file: ManagedFile }> {
  return request(
    connection,
    `/api/files/${encodeURIComponent(id)}`,
    {},
    fetcher
  )
}

export function validateSourceFile(
  file: Pick<File, 'name' | 'type' | 'size'>
): string {
  const extension = file.name.toLowerCase().split('.').pop() ?? ''
  const expectedMime = fileMimeTypes[extension]
  if (!expectedMime) {
    throw new Error(
      `${file.name}: PDF, DOCX, XLSX, PPTX, TXT, CSV 파일만 첨부할 수 있습니다.`
    )
  }
  const actualMime = file.type.toLowerCase().split(';')[0]?.trim()
  const csvAlternative =
    extension === 'csv' &&
    ['application/csv', 'text/plain'].includes(actualMime ?? '')
  if (actualMime && actualMime !== expectedMime && !csvAlternative) {
    throw new Error(`${file.name}: 파일 확장자와 형식이 일치하지 않습니다.`)
  }
  if (!Number.isFinite(file.size) || file.size <= 0)
    throw new Error(`${file.name}: 빈 파일은 첨부할 수 없습니다.`)
  if (file.size > MAX_SOURCE_FILE_BYTES)
    throw new Error(`${file.name}: 파일은 10 MiB 이하여야 합니다.`)
  return actualMime && csvAlternative ? actualMime : expectedMime
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export async function uploadSourceFile(
  file: File,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<ManagedFile> {
  const mimeType = validateSourceFile(file)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const result = await request<{ file: ManagedFile }>(
    connection,
    '/api/files',
    {
      method: 'POST',
      body: JSON.stringify({
        name: file.name,
        mimeType,
        base64: encodeBase64(bytes)
      })
    },
    fetcher
  )
  return result.file
}

export function createTask(
  connection: Connection,
  prompt: string,
  sourceFileIds: string[],
  sourceUrls: string[] = [],
  fetcher: Fetcher = fetch,
  workflow?: 'legal' | 'document'
): Promise<{ task: BackendTask }> {
  return request(
    connection,
    '/api/tasks',
    {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        sourceFileIds,
        sourceUrls,
        ...(workflow ? { workflow } : {})
      })
    },
    fetcher
  )
}

export async function reviseTask(
  id: string,
  kind: 'revision' | 'followup',
  message: string,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch,
  sources: { sourceFileIds?: string[]; sourceUrls?: string[] } = {}
): Promise<TaskDetails> {
  await request(
    connection,
    `/api/tasks/${encodeURIComponent(id)}/revise`,
    { method: 'POST', body: JSON.stringify({ kind, message, ...sources }) },
    fetcher
  )
  return getTaskDetails(id, connection, fetcher)
}

export function saveTaskDocument(
  id: string,
  markdown: string,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<{ artifact: BackendArtifact }> {
  return request(
    connection,
    `/api/tasks/${encodeURIComponent(id)}/document`,
    { method: 'POST', body: JSON.stringify({ markdown }) },
    fetcher
  )
}

export function cancelTask(
  id: string,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<TaskDetails> {
  return request(
    connection,
    `/api/tasks/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body: '{}' },
    fetcher
  )
}

export function rerunTask(
  id: string,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<TaskDetails> {
  return request(
    connection,
    `/api/tasks/${encodeURIComponent(id)}/run`,
    { method: 'POST', body: '{}' },
    fetcher
  )
}

export async function downloadFile(
  id: string,
  name: string,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch
): Promise<void> {
  const url = URL.createObjectURL(await getFileContent(id, connection, fetcher))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function getFileContent(
  id: string,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch,
  timeoutMs = FILE_DOWNLOAD_TIMEOUT_MS
): Promise<Blob> {
  const url = backendUrl(
    connection,
    `/api/files/${encodeURIComponent(id)}/content`
  )
  const timeout = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetcher(url, {
      headers: connection.token.trim()
        ? { Authorization: `Bearer ${connection.token.trim()}` }
        : undefined,
      cache: 'no-store',
      signal: timeout
    })
  } catch {
    if (timeout.aborted)
      throw new Error('파일 다운로드 시간이 초과됐습니다. 다시 시도해 주세요.')
    throw new Error(
      '백엔드에 연결할 수 없습니다. 주소와 서버 실행 상태를 확인해 주세요.'
    )
  }
  if (!response.ok)
    throw new Error(`파일 내용을 불러오지 못했습니다. (${response.status})`)
  try {
    return await response.blob()
  } catch {
    if (timeout.aborted)
      throw new Error('파일 다운로드 시간이 초과됐습니다. 다시 시도해 주세요.')
    throw new Error(
      '파일 내용을 끝까지 다운로드하지 못했습니다. 다시 시도해 주세요.'
    )
  }
}

export async function watchTask(
  id: string,
  onUpdate: (details: TaskDetails) => void,
  signal: AbortSignal,
  connection: Connection = defaultConnection,
  fetcher: Fetcher = fetch,
  options: { retryDelayMs?: number; maxRetries?: number } = {}
): Promise<void> {
  let lastId = 0
  let attempts = 0
  const refresh = async () => {
    const details = await getTaskDetails(id, connection, fetcher, signal)
    if (signal.aborted) return true
    onUpdate(details)
    return ['completed', 'failed', 'cancelled'].includes(details.task.status)
  }
  while (!signal.aborted) {
    try {
      const headers = new Headers()
      if (connection.token.trim())
        headers.set('Authorization', `Bearer ${connection.token.trim()}`)
      if (lastId) headers.set('Last-Event-ID', String(lastId))
      const response = await fetcher(
        backendUrl(connection, `/api/tasks/${encodeURIComponent(id)}/events`),
        { headers, signal, cache: 'no-store' }
      )
      if (!response.ok || !response.body)
        throw new ApiError(
          `작업 진행 상태를 읽지 못했습니다. (${response.status})`,
          response.status
        )
      const reader = response.body.getReader()
      const abort = () => {
        void reader.cancel().catch(() => undefined)
      }
      signal.addEventListener('abort', abort, { once: true })
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          if (buffer.length > 1_048_576)
            throw new Error('실시간 응답이 너무 큽니다.')
          const frames = buffer.split(/\r?\n\r?\n/)
          buffer = frames.pop() ?? ''
          let changed = false
          for (const frame of frames) {
            const lines = frame.split(/\r?\n/)
            const data = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n')
            if (!data) continue
            const event = JSON.parse(data) as BackendEvent
            if (!event.type) continue
            const cursor = Number(
              lines
                .find((line) => line.startsWith('id:'))
                ?.slice(3)
                .trim() ?? event.id
            )
            if (Number.isSafeInteger(cursor) && cursor > lastId) lastId = cursor
            changed = true
          }
          if (changed) {
            attempts = 0
            if (await refresh()) return
          }
        }
      } finally {
        signal.removeEventListener('abort', abort)
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
      if (signal.aborted || (await refresh())) return
    } catch (error) {
      if (signal.aborted) return
      if (
        error instanceof ApiError &&
        [400, 401, 403, 404].includes(error.status)
      )
        throw error
      if (attempts >= (options.maxRetries ?? 8)) throw error
    }
    attempts++
    if (attempts > (options.maxRetries ?? 8))
      throw new Error('실시간 연결이 끊어졌습니다. 연결을 다시 확인해 주세요.')
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(
        done,
        Math.min(
          10_000,
          (options.retryDelayMs ?? 500) * 2 ** Math.min(attempts - 1, 5)
        )
      )
      signal.addEventListener('abort', done, { once: true })
    })
  }
}
