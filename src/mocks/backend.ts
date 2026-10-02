import type {
  BackendArtifact,
  BackendEvent,
  BackendTask,
  LegalLibraryItem,
  ManagedFile,
  RuntimeCapabilities,
  TaskDetails
} from '@/api/workroom'

const STORAGE_KEY = 'workfolio-mock-backend-v1'
const STAGES = [
  '요청 정리',
  '첨부 자료 확인',
  '요청 분석',
  '문서 구성',
  '초안 작성',
  '결과 확인'
]
const STEP_DURATION_MS = 650

type MockFile = ManagedFile & { content?: string }
type MockDatabase = {
  tasks: BackendTask[]
  artifacts: BackendArtifact[]
  events: BackendEvent[]
  files: MockFile[]
  nextEventId: number
}

let memoryDatabase: MockDatabase = emptyDatabase()
const browserSessions = new Map<string, { title: string; url: string }>()

function emptyDatabase(): MockDatabase {
  return { tasks: [], artifacts: [], events: [], files: [], nextEventId: 1 }
}

function readDatabase(): MockDatabase {
  if (typeof window === 'undefined') return memoryDatabase
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (value) {
      const parsed = JSON.parse(value) as Partial<MockDatabase>
      memoryDatabase = {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        files: Array.isArray(parsed.files) ? parsed.files : [],
        nextEventId:
          typeof parsed.nextEventId === 'number' ? parsed.nextEventId : 1
      }
    }
  } catch {
    // Keep the in-memory demo usable when browser storage is unavailable.
  }
  return memoryDatabase
}

function writeDatabase(database: MockDatabase) {
  memoryDatabase = database
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(database))
  } catch {
    // Mock state still works for the current page when storage is full/blocked.
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function error(message: string, status = 404): Response {
  return json({ error: message }, status)
}

function readBody(options: RequestInit): Record<string, unknown> {
  if (typeof options.body !== 'string') return {}
  try {
    const value: unknown = JSON.parse(options.body)
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function titleFrom(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/u)[0] ?? '새 작업'
  return firstLine.length > 52 ? `${firstLine.slice(0, 52)}…` : firstLine
}

function draftFor(task: BackendTask): string {
  const request = task.prompt.trim()
  const safetyNote =
    task.workflow === 'legal'
      ? '목업 화면 확인용입니다. 실제 법령·판례를 검색하거나 법률 답변을 생성하지 않았습니다.'
      : '목업 화면 확인용입니다. 첨부 파일을 읽거나 외부 자료를 조사하지 않았습니다.'
  return [
    `# ${task.title}`,
    '',
    `> ${safetyNote}`,
    '',
    '## 요청',
    request,
    '',
    '## 초안 구조 예시',
    '',
    '### 목적',
    '요청에서 원하는 결과와 독자를 정리합니다.',
    '',
    '### 주요 내용',
    '필요한 자료와 확인 항목을 실제 내용으로 채울 자리입니다.',
    '',
    '### 다음 단계',
    '백엔드 연결 후 자료 조사와 결과 생성을 진행할 수 있습니다.'
  ].join('\n')
}

function makeFile(
  name: string,
  mimeType: string,
  content?: string,
  bytes = content ? new TextEncoder().encode(content).byteLength : 0
): MockFile {
  const file: MockFile = {
    id: `mock_file_${crypto.randomUUID()}`,
    name,
    mimeType,
    bytes,
    createdAt: new Date().toISOString(),
    ...(content === undefined ? {} : { content })
  }
  return file
}

function addOutputFile(
  database: MockDatabase,
  outputName: unknown,
  extension: string,
  mimeType: string,
  content: string
): ManagedFile {
  const requestedName =
    typeof outputName === 'string' && outputName.trim()
      ? outputName.trim()
      : '목업 결과'
  const baseName = requestedName.replace(/\.[a-z0-9]+$/iu, '')
  const file = makeFile(`${baseName}.${extension}`, mimeType, content)
  database.files.unshift(file)
  database.files = database.files.slice(0, 100)
  writeDatabase(database)
  return file
}

function createTask(
  database: MockDatabase,
  prompt: string,
  sourceFileIds: string[],
  sourceUrls: string[],
  workflow: 'legal' | 'document'
): BackendTask {
  const now = new Date().toISOString()
  const task: BackendTask = {
    id: `mock_task_${crypto.randomUUID()}`,
    title: titleFrom(prompt),
    prompt,
    sourceFileIds,
    sourceUrls,
    status: 'running',
    workflow,
    steps: STAGES.map((step, index) => ({
      id: `mock_step_${index + 1}`,
      title: step,
      status: index === 0 ? 'running' : 'pending',
      progress: index === 0 ? 10 : 0
    })),
    createdAt: now,
    updatedAt: now
  }
  database.tasks.unshift(task)
  database.tasks = database.tasks.slice(0, 30)
  return task
}

function advanceTask(database: MockDatabase, task: BackendTask): BackendTask {
  if (task.status !== 'running') return task
  const elapsed = Math.max(0, Date.now() - Date.parse(task.createdAt))
  const activeIndex = Math.min(
    STAGES.length,
    Math.floor(elapsed / STEP_DURATION_MS)
  )
  const completed = activeIndex >= STAGES.length
  const next: BackendTask = {
    ...task,
    status: completed ? 'completed' : 'running',
    updatedAt: new Date().toISOString(),
    steps: task.steps.map((step, index) => ({
      ...step,
      status:
        completed || index < activeIndex
          ? 'completed'
          : index === activeIndex
            ? 'running'
            : 'pending',
      progress:
        completed || index < activeIndex
          ? 100
          : index === activeIndex
            ? Math.min(
                90,
                Math.round(
                  ((elapsed % STEP_DURATION_MS) / STEP_DURATION_MS) * 100
                )
              )
            : 0
    }))
  }
  if (
    completed &&
    !database.artifacts.some((artifact) => artifact.taskId === task.id)
  ) {
    const content = draftFor(next)
    const file = addOutputFile(
      database,
      next.title,
      'md',
      'text/markdown',
      content
    )
    database.artifacts.unshift({
      id: `mock_artifact_${crypto.randomUUID()}`,
      taskId: next.id,
      name: file.name,
      kind: 'document',
      mimeType: file.mimeType,
      content,
      fileId: file.id,
      createdAt: new Date().toISOString()
    })
  }
  const index = database.tasks.findIndex((item) => item.id === task.id)
  if (index >= 0) database.tasks[index] = next
  return next
}

function taskDetails(
  database: MockDatabase,
  id: string
): TaskDetails | undefined {
  const stored = database.tasks.find((task) => task.id === id)
  if (!stored) return undefined
  const task = advanceTask(database, stored)
  writeDatabase(database)
  return {
    task,
    events: database.events.filter((event) => event.taskId === id),
    artifacts: database.artifacts.filter((artifact) => artifact.taskId === id)
  }
}

export function getMockCapabilities(): RuntimeCapabilities {
  return {
    model: { configured: false, provider: null },
    browserUse: { available: false },
    computerUse: { available: false, platform: '목업' },
    legalRetrieval: {
      enabled: false,
      ready: false,
      root: '',
      corpus: { laws: 0, precedents: 0, graphNodes: 0, graphEdges: 0 },
      vector: { ready: false, reason: '목업 모드' },
      ontology: { ready: false },
      okf: { ready: false },
      degraded: [],
      state: 'unavailable',
      message: '목업 모드에서는 실제 법령·판례 검색을 하지 않습니다.'
    },
    office: {
      docx: false,
      xlsx: false,
      pdf: false,
      ocr: false,
      googleDocs: false,
      googleSheets: false,
      formulaCalculation: false
    }
  }
}

export async function mockRequest(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  if (options.signal?.aborted) throw options.signal.reason
  const method = (options.method ?? 'GET').toUpperCase()
  const url = new URL(path, 'http://mock.local')
  const route = url.pathname.replace(/\/$/u, '') || '/'
  const body = readBody(options)
  const database = readDatabase()

  if (route === '/health' && method === 'GET') return json({ ok: true })
  if (route === '/api/capabilities' && method === 'GET')
    return json(getMockCapabilities())

  if (route === '/api/tasks' && method === 'GET') {
    for (const task of database.tasks) advanceTask(database, task)
    writeDatabase(database)
    return json({ items: database.tasks })
  }
  if (route === '/api/tasks' && method === 'POST') {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) return error('요청 내용을 입력해 주세요.', 400)
    const task = createTask(
      database,
      prompt,
      Array.isArray(body.sourceFileIds) ? body.sourceFileIds.map(String) : [],
      Array.isArray(body.sourceUrls) ? body.sourceUrls.map(String) : [],
      body.workflow === 'document' ? 'document' : 'legal'
    )
    writeDatabase(database)
    return json({ task }, 202)
  }

  const taskMatch = route.match(
    /^\/api\/tasks\/([^/]+)(?:\/(revise|document|cancel|run))?$/u
  )
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1] ?? '')
    const action = taskMatch[2]
    const stored = database.tasks.find((task) => task.id === id)
    if (!stored) return error('목업 작업을 찾을 수 없습니다.')
    if (!action && method === 'GET') {
      const details = taskDetails(database, id)
      return details ? json(details) : error('목업 작업을 찾을 수 없습니다.')
    }
    if (action === 'revise' && method === 'POST') {
      const message =
        typeof body.message === 'string' ? body.message.trim() : ''
      if (!message) return error('수정 요청을 입력해 주세요.', 400)
      const event: BackendEvent = {
        id: database.nextEventId++,
        taskId: id,
        type: 'task.revised',
        title: '목업 수정 요청',
        message: '목업 요청을 반영합니다.',
        status: 'running',
        createdAt: new Date().toISOString(),
        metadata: { kind: body.kind, message }
      }
      database.events.push(event)
      const task: BackendTask = {
        ...stored,
        prompt: `${stored.prompt}\n\n${message}`,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: STAGES.map((title, index) => ({
          id: `mock_step_${index + 1}`,
          title,
          status: index === 0 ? 'running' : 'pending',
          progress: index === 0 ? 10 : 0
        }))
      }
      database.tasks = database.tasks.map((item) =>
        item.id === id ? task : item
      )
      database.artifacts = database.artifacts.filter(
        (item) => item.taskId !== id
      )
      writeDatabase(database)
      return json({ task }, 202)
    }
    if (action === 'document' && method === 'POST') {
      const markdown = typeof body.markdown === 'string' ? body.markdown : ''
      const file = addOutputFile(
        database,
        stored.title,
        'md',
        'text/markdown',
        markdown
      )
      const artifact: BackendArtifact = {
        id: `mock_artifact_${crypto.randomUUID()}`,
        taskId: id,
        name: file.name,
        kind: 'document',
        mimeType: file.mimeType,
        content: markdown,
        fileId: file.id,
        createdAt: new Date().toISOString()
      }
      database.artifacts = database.artifacts.filter(
        (item) => item.taskId !== id
      )
      database.artifacts.unshift(artifact)
      writeDatabase(database)
      return json({ artifact })
    }
    if (action === 'cancel' && method === 'POST') {
      const task: BackendTask = {
        ...stored,
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
        steps: stored.steps.map((step) => ({
          ...step,
          status: step.status === 'completed' ? 'completed' : 'cancelled'
        }))
      }
      database.tasks = database.tasks.map((item) =>
        item.id === id ? task : item
      )
      writeDatabase(database)
      const details = taskDetails(database, id)
      return details ? json(details) : error('목업 작업을 찾을 수 없습니다.')
    }
    if (action === 'run' && method === 'POST') {
      const task: BackendTask = {
        ...stored,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: STAGES.map((title, index) => ({
          id: `mock_step_${index + 1}`,
          title,
          status: index === 0 ? 'running' : 'pending',
          progress: index === 0 ? 10 : 0
        }))
      }
      database.tasks = database.tasks.map((item) =>
        item.id === id ? task : item
      )
      database.artifacts = database.artifacts.filter(
        (item) => item.taskId !== id
      )
      writeDatabase(database)
      const details = taskDetails(database, id)
      return details ? json(details) : error('목업 작업을 찾을 수 없습니다.')
    }
  }

  if (route === '/api/files' && method === 'GET') {
    const query = (url.searchParams.get('search') ?? '').toLocaleLowerCase()
    const items = database.files
      .filter((file) => file.name.toLocaleLowerCase().includes(query))
      .map(({ id, name, mimeType, bytes, createdAt }) => ({
        id,
        name,
        mimeType,
        bytes,
        createdAt
      }))
    return json({ items })
  }
  if (route === '/api/files' && method === 'POST') {
    const name = typeof body.name === 'string' ? body.name : '첨부 파일'
    const mimeType =
      typeof body.mimeType === 'string'
        ? body.mimeType
        : 'application/octet-stream'
    const base64 = typeof body.base64 === 'string' ? body.base64 : ''
    const file = makeFile(
      name,
      mimeType,
      undefined,
      Math.floor(base64.length * 0.75)
    )
    database.files.unshift(file)
    writeDatabase(database)
    const { content: _content, ...metadata } = file
    return json({ file: metadata }, 201)
  }

  const fileMatch = route.match(/^\/api\/files\/([^/]+)(?:\/(content))?$/u)
  if (fileMatch) {
    const id = decodeURIComponent(fileMatch[1] ?? '')
    const file = database.files.find((item) => item.id === id)
    if (!file) return error('목업 파일을 찾을 수 없습니다.')
    if (fileMatch[2] && method === 'GET')
      return new Response(file.content ?? `목업 파일: ${file.name}`, {
        headers: { 'content-type': file.mimeType }
      })
    if (!fileMatch[2] && method === 'GET') {
      const { content: _content, ...metadata } = file
      return json({ file: metadata })
    }
  }

  if (route === '/api/legal/library' && method === 'GET') {
    return json({
      query: url.searchParams.get('q') ?? '',
      corpus: url.searchParams.get('corpus') ?? 'all',
      // Avoid returning fabricated laws, citations, or precedent excerpts.
      items: [] satisfies LegalLibraryItem[]
    })
  }
  if (route === '/api/legal/precedent' && method === 'GET') {
    const identifier = url.searchParams.get('identifier') ?? ''
    return json({
      item: {
        citationId: '목업',
        kind: 'precedent',
        corpus: 'precedent',
        recordId: 'mock-no-source',
        title: identifier || '판례 원문',
        excerpt: '목업 모드에서는 실제 판례 본문을 조회하지 않습니다.'
      },
      paging: { offset: 0, total: 0, hasMore: false },
      nextOffset: 0
    })
  }
  if (route === '/api/legal/tools' && method === 'GET')
    return json({ items: [] })
  if (route === '/api/legal/catalog' && method === 'GET')
    return json({ items: [] })

  if (route === '/api/search' && method === 'POST') return json({ items: [] })
  if (route === '/api/documents/markdown' && method === 'POST') {
    const content = typeof body.markdown === 'string' ? body.markdown : ''
    const file = addOutputFile(
      database,
      body.outputName,
      'md',
      'text/markdown',
      content
    )
    writeDatabase(database)
    return json({ file })
  }
  if (route === '/api/documents/extract' && method === 'POST') {
    const file = database.files.find((item) => item.id === body.fileId)
    return json({
      fileId: body.fileId,
      fileName: file?.name ?? '목업 파일',
      format: file?.mimeType ?? 'unknown',
      text: '목업 모드에서는 파일 내용을 읽지 않습니다.',
      warnings: ['실제 파일 추출을 수행하지 않았습니다.']
    })
  }
  if (route === '/api/documents/compare' && method === 'POST')
    return json({ added: [], removed: [], unchangedLines: 0 })
  if (route === '/api/documents/replace-text' && method === 'POST')
    return json({
      file: addOutputFile(
        database,
        body.outputName,
        'mock.txt',
        'text/plain',
        '목업 모드에서는 실제 문서 내용을 변경하지 않습니다.'
      ),
      replacements: 0,
      missing: []
    })
  if (route === '/api/documents/template-fill' && method === 'POST')
    return json({
      file: addOutputFile(
        database,
        body.outputName,
        'mock.txt',
        'text/plain',
        '목업 모드에서는 Word 템플릿을 처리하지 않습니다.'
      )
    })
  if (route === '/api/documents/redact' && method === 'POST')
    return json({
      file: addOutputFile(
        database,
        body.outputName,
        'mock.txt',
        'text/plain',
        '목업 모드에서는 실제 문서의 개인정보를 가리지 않습니다.'
      ),
      replacements: 0
    })
  if (route === '/api/documents/ai' && method === 'POST')
    return json({
      file: addOutputFile(
        database,
        body.outputName,
        'mock.txt',
        'text/plain',
        '목업 모드에서는 AI 문서 처리를 실행하지 않습니다.'
      ),
      text: '목업 모드에서는 AI 문서 처리를 실행하지 않습니다.'
    })

  if (route.startsWith('/api/spreadsheets/') && method === 'POST') {
    if (route.endsWith('/inspect'))
      return json({
        fileId: body.fileId,
        sheets: [],
        cells: [],
        formulaCalculation: 'not-performed'
      })
    return json({
      file: addOutputFile(
        database,
        body.outputName,
        'mock.txt',
        'text/plain',
        '목업 모드에서는 실제 스프레드시트를 만들거나 수정하지 않습니다.'
      )
    })
  }
  if (route === '/api/pdfs/inspect' && method === 'POST')
    return json({ pageCount: 0, pages: [] })
  if (route === '/api/pdfs/merge' && method === 'POST')
    return json({
      file: addOutputFile(
        database,
        body.outputName,
        'mock.txt',
        'text/plain',
        '목업 모드에서는 PDF 파일을 병합하지 않습니다.'
      )
    })
  if (route === '/api/pdfs/split' && method === 'POST')
    return json({ files: [] })
  if (route === '/api/pdfs/edit' && method === 'POST')
    return json({
      file: addOutputFile(
        database,
        body.outputName,
        'mock.txt',
        'text/plain',
        '목업 모드에서는 PDF 파일을 수정하지 않습니다.'
      )
    })

  if (route === '/api/browser/sessions' && method === 'POST') {
    const sessionId = `mock_browser_${crypto.randomUUID()}`
    const target = typeof body.url === 'string' ? body.url : 'about:blank'
    browserSessions.set(sessionId, { title: '목업 브라우저', url: target })
    return json({
      sessionId,
      title: '목업 브라우저',
      url: target,
      text: '목업 모드에서는 실제 웹사이트에 접속하지 않습니다.'
    })
  }
  const browserMatch = route.match(
    /^\/api\/browser\/sessions\/([^/]+)(?:\/actions)?$/u
  )
  if (browserMatch && method === 'DELETE') {
    browserSessions.delete(decodeURIComponent(browserMatch[1] ?? ''))
    return new Response(null, { status: 204 })
  }
  if (browserMatch && method === 'POST') {
    const session = browserSessions.get(
      decodeURIComponent(browserMatch[1] ?? '')
    )
    const action = body as { kind?: string; url?: string }
    return json({
      sessionId: browserMatch[1],
      title: session?.title ?? '목업 브라우저',
      url:
        action.kind === 'navigate'
          ? (action.url ?? session?.url ?? 'about:blank')
          : (session?.url ?? 'about:blank'),
      text: '목업 모드에서는 브라우저 동작을 실제로 실행하지 않습니다.'
    })
  }
  if (route === '/api/computer/actions' && method === 'POST')
    return json({ kind: 'mock', executed: false })

  return error(`목업 API에 등록되지 않은 경로입니다: ${method} ${route}`)
}

export async function downloadMockFile(
  id: string,
  name: string
): Promise<void> {
  const file = readDatabase().files.find((item) => item.id === id)
  if (!file) throw new Error('목업 파일을 찾을 수 없습니다.')
  const blob = new Blob(
    [
      file.content ??
        `목업 파일입니다. 실제 파일 생성은 수행되지 않았습니다.\n파일명: ${file.name}`
    ],
    { type: file.mimeType }
  )
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
