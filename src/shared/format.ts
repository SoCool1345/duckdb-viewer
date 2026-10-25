import { isBlobType } from './sql';

export interface FormattedCell {
  text: string | null;
  truncated: boolean;
}

const BLOB_PREFIX = /^\((\d+) bytes\) /;

/**
 * DuckDB renders blobs as `\xNN` escapes (4 characters per byte), so the
 * preview returned by SQL is already capped by character count. Other values
 * are truncated here, after they crossed the process boundary.
 */
export function formatCell(raw: string | null, dataType: string, maxChars: number): FormattedCell {
  if (raw === null) return { text: null, truncated: false };

  if (isBlobType(dataType)) {
    const match = BLOB_PREFIX.exec(raw);
    const byteLength = match?.[1] ? Number.parseInt(match[1], 10) : 0;
    const truncated = byteLength * 4 > Math.max(1, maxChars);
    return { text: raw, truncated };
  }

  const chars = Array.from(raw);
  if (chars.length <= maxChars) return { text: raw, truncated: false };
  return { text: chars.slice(0, maxChars).join(''), truncated: true };
}
