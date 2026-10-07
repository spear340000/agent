import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePages, parseRows } from './toolInputs'

test('page ranges preserve requested order and reject duplicate or unbounded expansion', () => {
  assert.deepEqual(parsePages('5,1-3'), [5, 1, 2, 3])
  for (const input of ['0', '1-100000000', '3-1', '1,1', '1,', 'one'])
    assert.throws(() => parsePages(input))
})
test('CSV and Excel pasted rows retain quoted separators, escaped quotes and embedded newlines', () => {
  assert.deepEqual(
    parseRows(
      'name,value\r\n"Kim, Min","said ""yes"""\r\n"two\nlines",15\r\n',
      ','
    ),
    [
      ['name', 'value'],
      ['Kim, Min', 'said "yes"'],
      ['two\nlines', '15']
    ]
  )
  assert.deepEqual(parseRows('분기\t금액\n1분기\t500\n', '\t'), [
    ['분기', '금액'],
    ['1분기', '500']
  ])
  assert.throws(() => parseRows('"unterminated', ','))
  assert.throws(() => parseRows('"closed"garbage', ','))
})
