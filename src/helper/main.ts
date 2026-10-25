import { cancelledError, classifyError, timeoutError } from '../shared/errors';
import { DEFAULT_OPERATION_TIMEOUT_MS } from '../shared/protocol';
import type {
  DisposeResult,
  ErrorCode,
  FetchCellParams,
  FetchPageParams,
  HelperErrorPayload,
  InterruptParams,
  RequestEnvelope,
  StatusResult,
} from '../shared/protocol';
import { HandleError, HandleTracker } from './handles';
import { listSchema } from './metadata';
import { fetchCell, fetchPage } from './page';

const HEARTBEAT_TIMEOUT_MS = 3000;
const HEARTBEAT_CHECK_MS = 500;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** If an interrupted request still holds a handle after this, exit hard. */
const FORCE_EXIT_MS = 5000;

const tracker = new HandleTracker();
const chains = new Map<string, Promise<unknown>>();
const cancelled = new Set<number>();
const running = new Set<number>();
const forceTimers = new Map<number, NodeJS.Timeout>();
let lastContact = Date.now();
let shuttingDown = false;
let buffer = '';

class RequestFailure extends Error {
  constructor(readonly payload: HelperErrorPayload) {
    super(payload.message);
  }
}

function send(message: unknown): void {
  if (shuttingDown) return;
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    process.exit(0);
  }
}

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdin.pause();
  // Give stdout a tick to flush before the process disappears.
  setTimeout(() => process.exit(code), 50);
}

function payloadFor(error: unknown): HelperErrorPayload {
  if (error instanceof RequestFailure) return error.payload;
  if (error instanceof HandleError) return error.payload;
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    return error as HelperErrorPayload;
  }
  return classifyError(error);
}

/**
 * Marks a request dead and, as a last resort, kills the whole helper if the
 * engine refuses to give the handle back. The helper is disposable: exiting is
 * always preferable to leaving a lock behind.
 */
function cancelRequest(id: number): void {
  cancelled.add(id);
  tracker.interrupt(id);
  if (forceTimers.has(id)) return;
  const timer = setTimeout(() => {
    forceTimers.delete(id);
    if (!running.has(id)) return;
    process.stderr.write(`[duckdb-viewer helper] request ${id} ignored interruption; terminating to release the lock\n`);
    shutdown(2);
  }, FORCE_EXIT_MS);
  timer.unref?.();
  forceTimers.set(id, timer);
}

function clearForceTimer(id: number): void {
  const timer = forceTimers.get(id);
  if (timer) clearTimeout(timer);
  forceTimers.delete(id);
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function withTimeout<T>(request: RequestEnvelope, task: () => Promise<T>): Promise<T> {
  const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_OPERATION_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // The task may still be queued (no connection yet), in which case it
      // checks `cancelled` before opening anything.
      cancelRequest(request.id);
      reject(new RequestFailure(timeoutError(timeoutMs)));
    }, timeoutMs);
  });

  const work = task();
  work.catch(() => undefined);

  return Promise.race([work, guard])
    .catch((error: unknown) => {
      // Interrupting the query rejects it slightly before the guard settles;
      // the user-visible reason must still be the timeout. Cancellations are
      // already translated inside the queued task.
      if (timedOut) throw new RequestFailure(timeoutError(timeoutMs));
      throw error;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

async function dispatch(request: RequestEnvelope): Promise<unknown> {
  switch (request.method) {
    case 'ping':
      return { pid: process.pid };

    case 'status': {
      const result: StatusResult = {
        openHandles: tracker.count,
        files: tracker.list(),
        version: process.versions.node,
      };
      return result;
    }

    case 'interrupt': {
      const params = request.params as InterruptParams | undefined;
      if (params?.targetId === undefined) return { interrupted: false };
      cancelRequest(params.targetId);
      return { interrupted: true };
    }

    case 'dispose': {
      const result: DisposeResult = { disposed: true };
      setTimeout(() => shutdown(0), 10);
      return result;
    }

    case 'openSession':
    case 'listSchema':
    case 'fetchPage':
    case 'fetchCell': {
      const dbPath = readDbPath(request.params);
      return enqueue(dbPath, async () => {
        running.add(request.id);
        try {
          // Do not open a database for a request the caller already gave up on.
          if (cancelled.has(request.id)) throw new RequestFailure(cancelledError());

          return await tracker.withReadOnly(
            request.id,
            dbPath,
            async (connection, fingerprint) => {
              if (request.method === 'openSession') {
                const reader = await connection.runAndReadAll('select version()');
                const version = String(reader.getRows()[0]?.[0] ?? '');
                return { version, fingerprint };
              }
              if (request.method === 'listSchema') {
                const reader = await connection.runAndReadAll('select version()');
                const version = String(reader.getRows()[0]?.[0] ?? '');
                const schemas = await listSchema(connection);
                return { version, fingerprint, schemas };
              }
              if (request.method === 'fetchPage') {
                return fetchPage(connection, request.params as FetchPageParams, fingerprint);
              }
              return fetchCell(connection, request.params as FetchCellParams);
            },
            () => cancelled.has(request.id),
          );
        } catch (error) {
          if (cancelled.has(request.id)) throw new RequestFailure(cancelledError());
          throw error;
        } finally {
          running.delete(request.id);
          cancelled.delete(request.id);
          clearForceTimer(request.id);
        }
      });
    }

    default: {
      const code: ErrorCode = 'INTERNAL';
      return Promise.reject({ code, message: `Unknown method: ${String(request.method)}` });
    }
  }
}

function readDbPath(params: unknown): string {
  const dbPath = (params as { dbPath?: unknown } | undefined)?.dbPath;
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    throw { code: 'INTERNAL', message: 'Request is missing dbPath.' } satisfies HelperErrorPayload;
  }
  return dbPath;
}

function handleLine(line: string): void {
  let parsed: RequestEnvelope;
  try {
    parsed = JSON.parse(line) as RequestEnvelope;
  } catch {
    send({ id: -1, ok: false, error: { code: 'INTERNAL', message: 'Malformed JSON request.' } });
    return;
  }
  if (typeof parsed?.id !== 'number' || typeof parsed?.method !== 'string') {
    send({ id: typeof parsed?.id === 'number' ? parsed.id : -1, ok: false, error: { code: 'INTERNAL', message: 'Invalid request envelope.' } });
    return;
  }

  withTimeout(parsed, () => dispatch(parsed)).then(
    (result) => {
      send({ id: parsed.id, ok: true, result });
    },
    (error: unknown) => {
      send({ id: parsed.id, ok: false, error: payloadFor(error) });
    },
  );
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  lastContact = Date.now();
  buffer += chunk;
  if (buffer.length > MAX_BUFFER_BYTES) {
    buffer = '';
    send({ id: -1, ok: false, error: { code: 'INTERNAL', message: 'Request exceeded the buffer limit.' } });
    return;
  }
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handleLine(line);
    newline = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (error) => {
  process.stderr.write(`[duckdb-viewer helper] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[duckdb-viewer helper] unhandled rejection: ${String(reason)}\n`);
});

const heartbeat = setInterval(() => {
  if (Date.now() - lastContact > HEARTBEAT_TIMEOUT_MS) shutdown(0);
}, HEARTBEAT_CHECK_MS);
heartbeat.unref();

send({ event: 'ready', pid: process.pid });
