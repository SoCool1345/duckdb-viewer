import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import fs from 'node:fs';
import { classifyError } from '../shared/errors';
import type { FileFingerprint, HelperErrorPayload } from '../shared/protocol';

export interface Triggerable {
  interrupt(): void;
}

export class HandleError extends Error {
  constructor(
    readonly payload: ReturnType<typeof classifyError>,
    override readonly cause?: unknown,
  ) {
    super(payload.message);
  }
}

export function readFingerprint(dbPath: string): FileFingerprint {
  const stat = fs.statSync(dbPath);
  const fingerprint: FileFingerprint = { mtimeMs: stat.mtimeMs, size: stat.size };
  try {
    const wal = fs.statSync(`${dbPath}.wal`);
    fingerprint.walMtimeMs = wal.mtimeMs;
    fingerprint.walSize = wal.size;
  } catch {
    // No WAL: the main file is the whole story.
  }
  return fingerprint;
}

/**
 * Owns every database handle in the helper. A handle exists only for the
 * duration of `withReadOnly`; the tracker's count is the observable proof
 * behind the "no lock at rest" guarantee.
 */
export class HandleTracker {
  private readonly openFiles = new Set<string>();
  private readonly active = new Map<number, Triggerable>();

  get count(): number {
    return this.openFiles.size;
  }

  list(): string[] {
    return [...this.openFiles];
  }

  interrupt(requestId: number): boolean {
    const trigger = this.active.get(requestId);
    if (!trigger) return false;
    try {
      trigger.interrupt();
    } catch {
      // Interrupting an already-finished query is harmless.
    }
    return true;
  }

  async withReadOnly<T>(
    requestId: number,
    dbPath: string,
    fn: (connection: DuckDBConnection, fingerprint: FileFingerprint) => Promise<T>,
    isCancelled?: () => boolean,
  ): Promise<T> {
    let fingerprint: FileFingerprint;
    try {
      fingerprint = readFingerprint(dbPath);
    } catch (error) {
      throw new HandleError(classifyError(error), error);
    }

    let instance: DuckDBInstance | undefined;
    let connection: DuckDBConnection | undefined;
    try {
      try {
        instance = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
      } catch (error) {
        throw new HandleError(classifyError(error), error);
      }
      this.openFiles.add(dbPath);
      connection = await instance.connect();
      this.active.set(requestId, connection);
      // A request can have timed out while waiting for the lock; do not run
      // it just because the queue finally reached it.
      if (isCancelled?.()) {
        throw {
          code: 'CANCELLED',
          message: 'Operation was cancelled before it started.',
        } satisfies HelperErrorPayload;
      }
      return await fn(connection, fingerprint);
    } finally {
      this.active.delete(requestId);
      try {
        connection?.closeSync();
      } catch {
        // Closing an already-closed connection must not mask the real error.
      }
      try {
        if (instance) instance.closeSync();
      } catch {
        // Same here.
      }
      this.openFiles.delete(dbPath);
    }
  }
}
