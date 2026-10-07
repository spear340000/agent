import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import WorkfolioSidebar from './WorkfolioSidebar.js'
import type { Task } from './types.js'

const task: Task = {
  id: 'task-1',
  title: '테스트 채팅',
  request: '요청',
  sources: [],
  messages: [],
  steps: [],
  stage: 'completed',
  state: 'completed',
  document: '',
  documentType: 'md',
  createdAt: 1,
  updatedAt: 1
}

function render(section: 'chat' | 'system') {
  return renderToStaticMarkup(
    createElement(WorkfolioSidebar, {
      tasks: [task],
      activeTaskId: task.id,
      filter: 'all',
      onFilterChange: () => undefined,
      onOpenTask: () => undefined,
      section,
      onSectionChange: () => undefined,
      toolsActive: false,
      onOpenTools: () => undefined,
      connectionLabel: '백엔드 연결 안 됨',
      backendStatus: 'offline',
      onOpenConnection: () => undefined,
      onReconnect: () => undefined,
      systemTopic: 'overview',
      onSystemTopicChange: () => undefined,
      mobileOpen: false,
      onMobileOpenChange: () => undefined
    })
  )
}

test('chat history is only shown inside the Chat tab', () => {
  const chat = render('chat')
  const system = render('system')

  assert.match(chat, /채팅 내역/)
  assert.match(chat, /테스트 채팅/)
  assert.doesNotMatch(system, /채팅 내역|테스트 채팅/)
  assert.match(system, /에이전틱 플로우/)
  assert.match(system, /RAG 검색/)
  assert.match(system, /LLM Wiki/)
})
