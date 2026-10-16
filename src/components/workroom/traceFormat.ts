/** Milliseconds as seconds with one decimal, e.g. 3.3초. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}초`
}

/** Token counts with thousands separators, e.g. 3,381. */
export function tokenCount(count: number): string {
  return count.toLocaleString('ko-KR')
}
