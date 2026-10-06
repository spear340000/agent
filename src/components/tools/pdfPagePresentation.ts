import type { PdfInspection } from '@/api/automation'

type PdfPage = PdfInspection['pages'][number]
export const PDF_PAGE_WINDOW_SIZE = 12

export function presentPdfPage(page: PdfPage) {
  const rotation = ((page.rotation % 360) + 360) % 360
  const swapsDimensions = rotation === 90 || rotation === 270
  const width = Math.max(0, swapsDimensions ? page.height : page.width)
  const height = Math.max(0, swapsDimensions ? page.width : page.height)
  const largestDimension = Math.max(width, height, 1)
  const scale = 72 / largestDimension

  return {
    orientation:
      width > height ? ('landscape' as const) : ('portrait' as const),
    widthMm: Math.round((width * 25.4) / 72),
    heightMm: Math.round((height * 25.4) / 72),
    paperWidth: Number((width * scale).toFixed(3)),
    paperHeight: Number((height * scale).toFixed(3))
  }
}

export function pdfPageWindow(totalPages: number, requestedStart: number) {
  const pageCount = Number.isFinite(totalPages)
    ? Math.max(0, Math.floor(totalPages))
    : 0
  if (!pageCount) return { start: 0, end: 0 }

  const requested = Number.isFinite(requestedStart)
    ? Math.max(0, Math.floor(requestedStart))
    : 0
  const lastWindowStart =
    Math.floor((pageCount - 1) / PDF_PAGE_WINDOW_SIZE) * PDF_PAGE_WINDOW_SIZE
  const start = Math.min(
    Math.floor(requested / PDF_PAGE_WINDOW_SIZE) * PDF_PAGE_WINDOW_SIZE,
    lastWindowStart
  )
  return {
    start,
    end: Math.min(pageCount, start + PDF_PAGE_WINDOW_SIZE)
  }
}
