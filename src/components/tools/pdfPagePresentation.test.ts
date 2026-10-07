import assert from 'node:assert/strict'
import test from 'node:test'

test('page orientation and displayed dimensions include PDF rotation', async () => {
  const { presentPdfPage } = await import('./pdfPagePresentation.js')

  assert.deepEqual(
    presentPdfPage({ number: 2, width: 612, height: 792, rotation: 90 }),
    {
      orientation: 'landscape',
      widthMm: 279,
      heightMm: 216,
      paperWidth: 72,
      paperHeight: 55.636
    }
  )
})

test('unrotated page dimensions retain the source orientation', async () => {
  const { presentPdfPage } = await import('./pdfPagePresentation.js')

  assert.deepEqual(
    presentPdfPage({ number: 1, width: 595.28, height: 841.89, rotation: 0 }),
    {
      orientation: 'portrait',
      widthMm: 210,
      heightMm: 297,
      paperWidth: 50.909,
      paperHeight: 72
    }
  )
})

test('large PDFs expose bounded thumbnail windows instead of mounting every page', async () => {
  const { pdfPageWindow } = await import('./pdfPagePresentation.js')

  assert.deepEqual(pdfPageWindow(2000, 0), { start: 0, end: 12 })
  assert.deepEqual(pdfPageWindow(2000, 24), { start: 24, end: 36 })
  assert.deepEqual(pdfPageWindow(25, 24), { start: 24, end: 25 })
  assert.deepEqual(pdfPageWindow(0, 0), { start: 0, end: 0 })
})
