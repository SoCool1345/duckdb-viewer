import { describe, expect, it } from 'vitest';
import { classifyError, parseLockInfo } from '../src/shared/errors';

const WINDOWS_LOCK = `IO Error: Cannot open file ".tmp/fixtures/fixture.duckdb": 另一个程序正在使用此文件，进程无法访问。

File is already open in 
E:\\Program Files\\nodejs\\node.exe (PID 24884)`;

const POSIX_LOCK = `IO Error: Could not set lock on file "data.duckdb": Conflicting lock is held in /usr/bin/python3.10 (PID 4242) by user alice.`;

describe('lock parsing', () => {
  it('extracts the pid and program from the Windows message', () => {
    const info = parseLockInfo(WINDOWS_LOCK);
    expect(info.pid).toBe(24884);
    expect(info.processName).toBe('node.exe');
  });

  it('extracts the pid and program from the POSIX message', () => {
    const info = parseLockInfo(POSIX_LOCK);
    expect(info.pid).toBe(4242);
    expect(info.processName).toBe('python3.10');
  });

  it('classifies the Windows message as LOCKED', () => {
    const payload = classifyError(new Error(WINDOWS_LOCK));
    expect(payload.code).toBe('LOCKED');
    expect(payload.pid).toBe(24884);
    expect(payload.processName).toBe('node.exe');
    expect(payload.message).toContain('Cannot open file');
  });

  it('classifies the POSIX message as LOCKED', () => {
    const payload = classifyError(new Error(POSIX_LOCK));
    expect(payload.code).toBe('LOCKED');
    expect(payload.pid).toBe(4242);
  });
});

describe('other error classes', () => {
  it('recognises a database written by a newer DuckDB', () => {
    const payload = classifyError(new Error('IO Error: The file was created with a newer version of DuckDB.'));
    expect(payload.code).toBe('VERSION_TOO_NEW');
  });

  it('recognises storage version complaints', () => {
    const payload = classifyError(new Error('Invalid Input Error: Unsupported storage version 99 for file data.duckdb'));
    expect(payload.code).toBe('VERSION_TOO_NEW');
  });

  it('recognises a corrupt database file', () => {
    const payload = classifyError(new Error('IO Error: not a valid DuckDB database file'));
    expect(payload.code).toBe('CORRUPT');
  });

  it('recognises a missing file', () => {
    const payload = classifyError(new Error('IO Error: Cannot open file "x.duckdb": The system cannot find the file specified.'));
    expect(payload.code).toBe('NOT_FOUND');
  });

  it('recognises a database that does not exist in read-only mode', () => {
    const payload = classifyError(new Error('IO Error: Cannot open database "x.duckdb" in read-only mode: database does not exist'));
    expect(payload.code).toBe('NOT_FOUND');
  });

  it('falls back to SQL_ERROR for query failures', () => {
    const payload = classifyError(new Error('Binder Error: Referenced column "nope" not found'));
    expect(payload.code).toBe('SQL_ERROR');
    expect(payload.message).toContain('Binder Error');
  });
});
