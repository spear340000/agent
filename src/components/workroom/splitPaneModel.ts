export const MIN_CONTEXT_PANE_WIDTH = 240
export const MAX_CONTEXT_PANE_WIDTH = 460
export const DEFAULT_CONTEXT_PANE_WIDTH = 280

export function resizeContextPaneWidth(
  startWidth: number,
  pointerDelta: number
): number {
  const proposedWidth = startWidth + pointerDelta
  if (!Number.isFinite(proposedWidth)) return DEFAULT_CONTEXT_PANE_WIDTH
  return Math.round(
    Math.min(
      MAX_CONTEXT_PANE_WIDTH,
      Math.max(MIN_CONTEXT_PANE_WIDTH, proposedWidth)
    )
  )
}
