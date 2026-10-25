import { describe, expect, it } from 'vitest';
import { shouldShowStatus, statusLabel } from '../src/host/status';

describe('status bar label', () => {
  it('says the lock is free when nothing is running', () => {
    expect(statusLabel(0, 1)).toBe('$(database) DuckDB: 未占锁');
  });

  it('says the lock is held while a request is running', () => {
    expect(statusLabel(1, 1)).toContain('持有锁');
    expect(statusLabel(1, 1)).toContain('sync~spin');
  });

  it('is hidden when no database tab is open', () => {
    expect(shouldShowStatus(0)).toBe(false);
    expect(statusLabel(0, 0)).toBe('');
    expect(shouldShowStatus(2)).toBe(true);
  });
});
