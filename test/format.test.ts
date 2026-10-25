import { describe, expect, it } from 'vitest';
import { formatCell } from '../src/shared/format';

describe('formatCell', () => {
  it('keeps nulls distinct from empty strings', () => {
    expect(formatCell(null, 'VARCHAR', 10)).toEqual({ text: null, truncated: false });
    expect(formatCell('', 'VARCHAR', 10)).toEqual({ text: '', truncated: false });
  });

  it('does not truncate small values', () => {
    expect(formatCell('12345678901234567890.1234567890', 'DECIMAL(38,10)', 4096)).toEqual({
      text: '12345678901234567890.1234567890',
      truncated: false,
    });
  });

  it('truncates long text and reports it', () => {
    const formatted = formatCell('abcdef', 'VARCHAR', 3);
    expect(formatted).toEqual({ text: 'abc', truncated: true });
  });

  it('does not split surrogate pairs when truncating', () => {
    const formatted = formatCell('😀😀😀', 'VARCHAR', 2);
    expect(formatted.text).toBe('😀😀');
    expect(formatted.truncated).toBe(true);
  });

  it('marks a blob as truncated when its escaped preview hits the cap', () => {
    expect(formatCell('(2 bytes) \\x01\\x02', 'BLOB', 4096)).toEqual({
      text: '(2 bytes) \\x01\\x02',
      truncated: false,
    });
    expect(formatCell('(5000 bytes) \\x01\\x02', 'BLOB', 4096).truncated).toBe(true);
  });
});
