import type { ErrorCode, HelperErrorPayload } from './protocol';

/**
 * Turns raw DuckDB / native errors into the small error vocabulary the UI
 * understands. The helper never sends raw stack traces to the extension.
 */

const LOCK_PATTERNS = [
  // Windows (localized OS message), English program name line.
  /File is already open in\s+(?<program>[^\r\n]+?)\s*\(PID\s+(?<pid>\d+)\)/i,
  // POSIX style.
  /Conflicting lock is held in\s+(?<program>[^\r\n(]+?)\s*\(PID\s+(?<pid>\d+)\)/i,
  // Some builds omit the program and only report the pid.
  /File is already open in[^\r\n]*?PID\s+(?<pid>\d+)/i,
];

const VERSION_PATTERNS = [
  /created with a newer version of duckdb/i,
  /storage version[^\n]*newer/i,
  /newer version of duckdb/i,
  /unsupported storage version/i,
];

const CORRUPT_PATTERNS = [
  /not a valid duckdb database/i,
  /invalid database file/i,
  /invalid magic bytes/i,
  /the file is not a duckdb/i,
  /corrupt/i,
];

const MISSING_PATTERNS = [
  /no such file or directory/i,
  /cannot open file[^\n]*: the system cannot find/i,
  /database does not exist/i,
  /ENOENT/i,
];

function extractProgram(raw: string): string | undefined {
  const base = raw.split(/[\\/]/).pop()?.trim();
  return base && base.length > 0 ? base : undefined;
}

export function parseLockInfo(message: string): { pid?: number; processName?: string } {
  for (const pattern of LOCK_PATTERNS) {
    const match = pattern.exec(message);
    if (match?.groups) {
      const pid = match.groups.pid ? Number.parseInt(match.groups.pid, 10) : undefined;
      const program = match.groups.program ? extractProgram(match.groups.program.replace(/\(PID.*$/, '')) : undefined;
      return { pid: Number.isFinite(pid) ? pid : undefined, processName: program };
    }
  }
  return {};
}

export function classifyError(error: unknown): HelperErrorPayload {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split(/\r?\n/)[0] ?? message;

  if (LOCK_PATTERNS.some((pattern) => pattern.test(message))) {
    const { pid, processName } = parseLockInfo(message);
    return {
      code: 'LOCKED',
      message: firstLine,
      detail: message,
      ...(pid !== undefined ? { pid } : {}),
      ...(processName !== undefined ? { processName } : {}),
    };
  }

  if (VERSION_PATTERNS.some((pattern) => pattern.test(message))) {
    return { code: 'VERSION_TOO_NEW', message: firstLine, detail: message };
  }

  if (MISSING_PATTERNS.some((pattern) => pattern.test(message))) {
    return { code: 'NOT_FOUND', message: firstLine, detail: message };
  }

  if (CORRUPT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { code: 'CORRUPT', message: firstLine, detail: message };
  }

  return { code: 'SQL_ERROR', message: firstLine, detail: message };
}

export function isLockError(payload: HelperErrorPayload): boolean {
  return payload.code === 'LOCKED';
}

export function cancelledError(): HelperErrorPayload {
  return { code: 'CANCELLED', message: 'Operation cancelled.' };
}

export function timeoutError(timeoutMs: number): HelperErrorPayload {
  return { code: 'TIMEOUT', message: `Operation exceeded ${timeoutMs}ms and was abandoned.` };
}
