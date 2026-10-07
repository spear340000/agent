import assert from 'node:assert/strict'
import test from 'node:test'
import {
  blankDuplicateTitle,
  cleanWikiMarkdown,
  friendlyErrorMessage,
  friendlyTaskError
} from './displayText.js'

test('wiki front matter and literal unicode escapes are not shown', () => {
  const raw = '---\ntitle: x\nsource: a\n---\n\n# \\uBBFC\\uBC95\n본문'
  assert.equal(cleanWikiMarkdown(raw), '# 민법\n본문')
  assert.equal(
    cleanWikiMarkdown('--- 구분선이 아님\n본문'),
    '--- 구분선이 아님\n본문'
  )
})

test('a first heading equal to the page title is blanked without shifting lines', () => {
  assert.equal(
    blankDuplicateTitle('# 제목\n\n## 절\n내용', '제목'),
    '\n\n## 절\n내용'
  )
  assert.equal(
    blankDuplicateTitle('# 다른 제목\n내용', '제목'),
    '# 다른 제목\n내용'
  )
  assert.equal(blankDuplicateTitle('내용\n# 제목', '제목'), '내용\n# 제목')
})

test('raw timeout and network messages become user-facing Korean', () => {
  assert.match(friendlyErrorMessage(new Error('signal timed out'), 'x'), /지연/)
  const timeout = new Error('The operation was aborted')
  timeout.name = 'TimeoutError'
  assert.match(friendlyErrorMessage(timeout, 'x'), /지연/)
  assert.match(friendlyErrorMessage(new Error('Failed to fetch'), 'x'), /연결/)
  assert.equal(
    friendlyErrorMessage(new Error('파일을 다시 첨부해 주세요.'), 'x'),
    '파일을 다시 첨부해 주세요.'
  )
  assert.equal(friendlyErrorMessage('boom', '대체 문구'), '대체 문구')
})

test('the metadata block under a wiki page title is hidden, but a real horizontal rule is kept', () => {
  const page =
    '---\r\ntype: Document\r\n---\r\n\r\n# 감사원규칙\r\n\r\n---\r\n제목: 규칙\r\n법령MST: 209959\r\n소관부처:\r\n- 감사원\r\n---\r\n\r\n본문 시작'
  assert.equal(
    cleanWikiMarkdown(page).replace(/(\r?\n){3,}/g, '\r\n\r\n'),
    '# 감사원규칙\r\n\r\n본문 시작'
  )
  const rule = '# 제목\n\n---\n\n본문 문장입니다.\n\n---\n끝'
  assert.equal(cleanWikiMarkdown(rule), rule)
})

test('infrastructure task failures are explained in Korean while other errors are kept', () => {
  assert.match(
    friendlyTaskError(
      'legal retrieval process is unavailable after its single restart attempt'
    ),
    /법령 검색 서버/
  )
  assert.match(friendlyTaskError('signal timed out'), /지연/)
  assert.equal(
    friendlyTaskError('모든 모델 제공자 요청에 실패했습니다.'),
    '모든 모델 제공자 요청에 실패했습니다.'
  )
})
