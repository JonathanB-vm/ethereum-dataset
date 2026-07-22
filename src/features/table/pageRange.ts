/** Footer "Showing X–Y of Z" range math, pulled out so it's independently testable. */
export function pageRange(pageIndex: number, pageSize: number, total: number): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 }
  const from = pageIndex * pageSize + 1
  const to = Math.min(total, (pageIndex + 1) * pageSize)
  return { from, to }
}
