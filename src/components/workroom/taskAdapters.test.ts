import assert from 'node:assert/strict'
import test from 'node:test'
import { modelUseFromEvents, toWorkroomTask } from './taskAdapters.js'
import type { TaskDetails } from '@/api/workroom'

test('a planning failure does not leave pending sources pretending to be actively collected', () => {
  const details: TaskDetails = {
    task: {
      id: 'quota-failed',
      title: '검증',
      prompt: '문서 작성',
      status: 'failed',
      sourceFileIds: ['file'],
      sourceUrls: ['https://example.com/'],
      createdAt: '',
      updatedAt: '',
      steps: [
        { id: 'plan', title: '계획', status: 'failed', progress: 0 },
        { id: 'documents', title: '자료', status: 'pending', progress: 0 },
        { id: 'research', title: '검색', status: 'pending', progress: 0 }
      ]
    },
    events: [],
    artifacts: []
  }
  assert.deepEqual(
    toWorkroomTask(details).sources.map((source) => source.status),
    ['queued', 'queued']
  )
})

test('equal-timestamp artifact versions use the last persisted version, and revisions reset source status', () => {
  const details: TaskDetails = {
    task: {
      id: 'task',
      title: '문서',
      prompt: '수정',
      sourceFileIds: ['file'],
      sourceUrls: [],
      status: 'queued',
      steps: [],
      createdAt: '',
      updatedAt: ''
    },
    events: [],
    artifacts: ['이전', '최신'].map((content, index) => ({
      id: String(index),
      taskId: 'task',
      name: '문서.docx',
      kind: 'document',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content,
      createdAt: '2026-09-30T00:00:00Z'
    }))
  }
  const task = toWorkroomTask(details, {
    sources: [
      {
        id: 'file',
        fileId: 'file',
        name: '원본.docx',
        kind: 'file',
        status: 'ready'
      }
    ]
  })
  assert.equal(task.document, '최신')
  assert.equal(task.sources[0]?.status, 'queued')
})

test('backend task details supply the document and real source metadata shown in the workroom', () => {
  const task = toWorkroomTask(
    {
      task: {
        id: 'task_123',
        title: '분기 실적 요약',
        prompt: '첨부 자료를 요약해 주세요.',
        sourceFileIds: ['file_123'],
        sourceUrls: ['https://example.com/report'],
        status: 'completed',
        steps: [
          {
            id: 'step_5',
            title: 'Generate cited DOCX',
            status: 'completed',
            progress: 100
          }
        ],
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:01:00.000Z'
      },
      events: [],
      artifacts: [
        {
          id: 'artifact_123',
          taskId: 'task_123',
          name: '분기 실적 요약.docx',
          kind: 'document',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          content: '# 분기 실적 요약\n\n본문',
          fileId: 'file_output_123',
          createdAt: '2026-09-29T00:01:00.000Z'
        }
      ]
    },
    {
      sources: [
        {
          id: 'file_123',
          fileId: 'file_123',
          name: '실적.xlsx',
          kind: 'file'
        }
      ],
      document: '',
      messages: []
    }
  )

  assert.equal(task.id, 'task_123')
  assert.equal(task.state, 'completed')
  assert.equal(task.document, '# 분기 실적 요약\n\n본문')
  assert.equal(task.artifactFileId, 'file_output_123')
  assert.equal(
    task.artifactMimeType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
  assert.deepEqual(
    task.sources.map(({ name, kind, url }) => ({ name, kind, url })),
    [
      { name: '실적.xlsx', kind: 'file', url: undefined },
      { name: 'example.com', kind: 'link', url: 'https://example.com/report' }
    ]
  )
})

test('preservesDirtyDocumentWhenTaskDetailsRefresh', () => {
  const localDraft = '# Local edit\n\nUnsaved changes stay visible.'
  const task = toWorkroomTask(
    {
      task: {
        id: 'task_live',
        title: '운영 계획',
        prompt: '계획 문서를 작성해 주세요.',
        sourceFileIds: [],
        sourceUrls: [],
        status: 'running',
        steps: [
          {
            id: 'step_1',
            title: 'Plan task',
            status: 'completed',
            progress: 100
          },
          {
            id: 'step_2',
            title: 'Read source files',
            status: 'completed',
            progress: 100
          },
          {
            id: 'step_3',
            title: 'Research the web',
            status: 'completed',
            progress: 100
          },
          {
            id: 'step_4',
            title: 'Analyze evidence',
            status: 'running',
            progress: 45
          }
        ],
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:02:00.000Z'
      },
      events: [],
      artifacts: [
        {
          id: 'artifact_server',
          taskId: 'task_live',
          name: '운영 계획.docx',
          kind: 'document',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          content: '# Server version',
          fileId: 'file_server',
          createdAt: '2026-09-29T00:01:00.000Z'
        }
      ]
    },
    { document: localDraft, documentDirty: true }
  )

  assert.equal(task.document, localDraft)
  assert.equal(task.documentDirty, true)
  assert.equal(task.savedDocument, '# Server version')
  assert.equal(task.state, 'running')
  assert.equal(task.stage, 'analyzing')
})

test('a legal answer event supplies citations, source status, and the retrieval path', () => {
  const task = toWorkroomTask({
    task: {
      id: 'task_legal',
      title: '민법 제398조',
      prompt: '민법 제398조가 정하는 손해배상 예정이 어떻게 되나요?',
      sourceFileIds: [],
      sourceUrls: [],
      status: 'completed',
      steps: [
        {
          id: 'step_1',
          title: '법령·판례 근거 확인',
          status: 'completed',
          progress: 100
        },
        {
          id: 'step_2',
          title: '근거 기반 답변 작성',
          status: 'completed',
          progress: 100
        }
      ],
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:01:00.000Z'
    },
    events: [
      {
        id: 1,
        taskId: 'task_legal',
        type: 'legal.answer',
        title: '법률 답변 준비됨',
        message: '1건의 근거를 확인했습니다.',
        status: 'completed',
        createdAt: '2026-09-30T00:01:00.000Z',
        metadata: {
          intent: 'article-lookup',
          path: 'direct',
          answer: '조문은 손해배상액의 예정이 가능합니다 [L1].',
          plannerCalls: 0,
          toolCalls: 1,
          citations: [
            {
              citationId: 'L1',
              recordId: 'law:민법#제398조',
              corpus: 'law',
              label: '민법 제398조 (배상액의 예정)',
              officialUrl: 'https://www.law.go.kr/법령/민법',
              date: { kind: 'amendment', value: '2010.1.22' }
            },
            {
              citationId: 'P1',
              recordId: 'case:2013가합30895',
              corpus: 'precedent',
              label: '인천지방법원 · 2013가합30895'
            }
          ],
          sourceStatus: {
            corpusReady: true,
            retrieved: 2,
            degraded: ['vector'],
            currentness: 'record-dated',
            notes: [
              '벡터 검색을 사용하지 못해 키워드·그래프 검색 결과만 사용했습니다.'
            ],
            failures: []
          }
        }
      }
    ],
    artifacts: []
  })

  assert.equal(task.legal?.path, 'direct')
  assert.equal(task.legal?.intent, 'article-lookup')
  assert.equal(task.legal?.plannerCalls, 0)
  assert.equal(task.legal?.toolCalls, 1)
  assert.deepEqual(
    task.legal?.citations.map((citation) => citation.citationId),
    ['L1', 'P1']
  )
  assert.equal(task.legal?.citations[0]?.date?.kind, 'amendment')
  assert.equal(task.legal?.sourceStatus.currentness, 'record-dated')
  assert.deepEqual(task.legal?.sourceStatus.degraded, ['vector'])
  assert.deepEqual(
    task.steps.map((step) => step.title),
    ['법령·판례 근거 확인', '근거 기반 답변 작성']
  )
})

test('a degraded or malformed legal event never invents a source status', () => {
  const task = toWorkroomTask({
    task: {
      id: 'task_legal_bad',
      title: '질문',
      prompt: '위약금 감액 기준 알려 주세요.',
      sourceFileIds: ['file_1'],
      sourceUrls: ['https://example.com/law'],
      status: 'failed',
      steps: [
        {
          id: 'step_1',
          title: '첨부 자료 확인',
          status: 'completed',
          progress: 100
        },
        {
          id: 'step_2',
          title: '법령·판례 근거 확인',
          status: 'failed',
          progress: 0,
          error: '법령 검색 프로세스를 시작하지 못했습니다.'
        }
      ],
      createdAt: '',
      updatedAt: ''
    },
    events: [
      {
        id: 1,
        taskId: 'task_legal_bad',
        type: 'legal.answer',
        title: '법률 답변 준비됨',
        message: '',
        status: 'completed',
        createdAt: '',
        metadata: { intent: 'legal-question' }
      }
    ],
    artifacts: []
  })

  assert.equal(task.legal, undefined)
  assert.deepEqual(
    task.sources.map((source) => source.status),
    ['ready', 'queued']
  )
})

test('a failed task still exposes the persisted retrieval tool ledger', () => {
  const task = toWorkroomTask({
    task: {
      id: 'task_retrieval_only',
      title: '검색 후 웹 실패',
      prompt: '현재 법령과 공식 링크를 확인해 주세요.',
      sourceFileIds: [],
      sourceUrls: [],
      status: 'failed',
      steps: [],
      createdAt: '',
      updatedAt: ''
    },
    events: [
      {
        id: 1,
        taskId: 'task_retrieval_only',
        type: 'legal.retrieval',
        title: '법령·판례 검색 완료',
        message: '1건의 실제 검색 근거를 확보했습니다.',
        status: 'completed',
        createdAt: '',
        metadata: {
          intent: 'legal-question',
          path: 'direct',
          plannerCalls: 0,
          toolCalls: 1,
          sourceStatus: {
            corpusReady: true,
            retrieved: 1,
            cited: 0,
            degraded: [],
            currentness: 'unverified',
            notes: [],
            failures: [],
            ledger: {
              layers: [],
              toolCalls: 1,
              maxToolCalls: 8,
              planner: { calls: 0, mode: 'not-used' },
              tools: [
                {
                  tool: 'search_laws',
                  label: '법령 검색',
                  query: '현재 법령과 공식 링크를 확인해 주세요.',
                  results: 1
                }
              ]
            }
          }
        }
      }
    ],
    artifacts: []
  })
  assert.equal(task.legal?.toolCalls, 1)
  assert.equal(task.legal?.sourceStatus.ledger?.tools[0]?.tool, 'search_laws')
})

test('the model that actually answered, and any failed fallbacks, come from the task event', () => {
  const event = (metadata: Record<string, unknown>) => ({
    id: 1,
    taskId: 't',
    type: 'model.attempts',
    title: '모델 사용 기록',
    message: '',
    status: 'warning',
    createdAt: '',
    metadata
  })
  assert.deepEqual(
    modelUseFromEvents([
      event({
        finalModel: 'backup',
        fellBack: true,
        attempts: [
          { model: 'primary', ok: false },
          { model: 'primary', ok: false },
          { model: 'backup', ok: true }
        ]
      })
    ]),
    { finalModel: 'backup', fellBack: true, failedModels: ['primary'] }
  )
  assert.equal(modelUseFromEvents([]), undefined)
})
