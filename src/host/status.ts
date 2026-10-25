/**
 * The status bar text is a pure function of viewer activity so that the
 * "am I holding a lock?" question has one answer in one place.
 */
export function statusLabel(busyCount: number, openEditors: number): string {
  if (openEditors === 0) return '';
  return busyCount > 0 ? '$(sync~spin) DuckDB: 查询中（持有锁）' : '$(database) DuckDB: 未占锁';
}

export function shouldShowStatus(openEditors: number): boolean {
  return openEditors > 0;
}
