import { describe, expect, it } from 'vitest';
import { ColumnLayoutStore } from '../src/host/columnLayoutStore';
import { DbSession } from '../src/host/session';
import { RpcError } from '../src/host/rpcClient';
import type { HelperClient } from '../src/host/rpcClient';
import { emptyState } from '../src/shared/messages';
import type { ViewerState } from '../src/shared/messages';
import type { FetchPageParams, FetchPageResult, ListSchemaResult } from '../src/shared/protocol';
import { MemoryMemento } from './helpers/memoryMemento';

const FINGERPRINT = { mtimeMs: 1_000, size: 4_096 };

const SCHEMA: ListSchemaResult = {
  version: 'v1.5.6',
  fingerprint: FINGERPRINT,
  schemas: [
    {
      name: 'main',
      objects: [
        {
          schema: 'main',
          name: 'users',
          kind: 'table',
          columns: [
            { name: 'id', dataType: 'BIGINT', nullable: false },
            { name: 'name', dataType: 'VARCHAR', nullable: true },
          ],
          constraints: [],
          estimatedRows: 3,
        },
        {
          schema: 'main',
          name: 'orders',
          kind: 'table',
          columns: [
            { name: 'id', dataType: 'BIGINT', nullable: false },
            { name: 'total', dataType: 'DOUBLE', nullable: true },
          ],
          constraints: [],
          estimatedRows: 2,
        },
      ],
    },
  ],
};

interface Call {
  method: string;
  params: unknown;
}

function fakePage(params: FetchPageParams): FetchPageResult {
  const offset = params.cursor.kind === 'offset' ? params.cursor.offset : 0;
  const rows = [0, 1].map((index) => ({
    rowid: String(offset + index),
    cells: [String(offset + index), `name-${offset + index}`],
    truncated: [],
  }));
  return {
    columns: params.columns,
    rows,
    paging: params.sort ? 'offset' : 'keyset',
    stableOrder: params.kind === 'table',
    hasMore: true,
    hasPrev: offset > 0,
    offset,
    pageIndex: 0,
    estimatedRows: 3,
    estimated: true,
    firstRowid: rows[0]?.rowid ?? null,
    lastRowid: rows[1]?.rowid ?? null,
    fingerprint: FINGERPRINT,
  };
}

function makeSession(
  handler: (call: Call) => Promise<unknown>,
  overrides: Partial<{ pageSize: number }> = {},
): {
  session: DbSession;
  states: ViewerState[];
  calls: Call[];
  toasts: string[];
  columnLayouts: ColumnLayoutStore;
  memento: MemoryMemento;
} {
  const states: ViewerState[] = [];
  const calls: Call[] = [];
  const toasts: string[] = [];
  const memento = new MemoryMemento();
  const columnLayouts = new ColumnLayoutStore(memento);
  const client = {
    request: async (method: string, params: unknown, _timeout?: number, onId?: (id: number) => void) => {
      const call = { method, params: structuredClone(params) as unknown };
      calls.push(call);
      onId?.(calls.length);
      return handler(call);
    },
  } as unknown as HelperClient;

  const session = new DbSession({
    dbPath: 'C:/data/test.duckdb',
    dbName: 'test.duckdb',
    client,
    pageSize: overrides.pageSize ?? 2,
    operationTimeoutMs: 5_000,
    maxCellBytes: 4096,
    columnLayouts,
    waitIntervalMs: 10,
    onState: (state) => states.push(state),
    onBusyChange: () => undefined,
    onCellDetail: () => undefined,
    onToast: (level, message) => toasts.push(`${level}:${message}`),
  });

  return { session, states, calls, toasts, columnLayouts, memento };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timeout');
}

const latest = (states: ViewerState[]): ViewerState => states.at(-1) ?? emptyState('test.duckdb', 2);

function handlerFor(options: { locked?: boolean; page?: (params: FetchPageParams) => FetchPageResult } = {}) {
  return async (call: Call): Promise<unknown> => {
    switch (call.method) {
      case 'listSchema':
        if (options.locked) {
          throw new RpcError({ code: 'LOCKED', message: 'File is already open', pid: 4242, processName: 'python.exe' });
        }
        return SCHEMA;
      case 'fetchPage': {
        const params = call.params as FetchPageParams;
        return options.page ? options.page(params) : fakePage(params);
      }
      default:
        return {};
    }
  };
}

describe('DbSession', () => {
  it('loads the schema and the first page of the first table', async () => {
    const { session, states, calls } = makeSession(handlerFor());
    session.start();
    await waitFor(() => latest(states).rows.length > 0 && latest(states).status === 'ready');

    expect(calls.map((call) => call.method)).toEqual(['listSchema', 'fetchPage']);
    const state = latest(states);
    expect(state.selected).toEqual({ schema: 'main', name: 'users', kind: 'table' });
    expect(state.columns.map((column) => column.name)).toEqual(['id', 'name']);
    expect(state.estimatedRows).toBe(3);
    expect(state.rows[0]?.cells[0]).toBe('0');
    expect(states.some((entry) => entry.busy)).toBe(true);
    session.dispose();
  });

  it('pages forward with a rowid keyset cursor and back with a before cursor', async () => {
    const { session, states, calls } = makeSession(handlerFor());
    session.start();
    await waitFor(() => latest(states).rows.length > 0);

    session.handleMessage({ type: 'nextPage' });
    await waitFor(() => calls.filter((call) => call.method === 'fetchPage').length === 2);
    const next = calls.filter((call) => call.method === 'fetchPage')[1]?.params as FetchPageParams;
    expect(next.cursor).toEqual({ kind: 'rowid', after: '1' });

    session.handleMessage({ type: 'prevPage' });
    await waitFor(() => latest(states).pageIndex === 0 && latest(states).hasPrev === false);
    const back = calls.filter((call) => call.method === 'fetchPage')[2]?.params as FetchPageParams;
    expect(back.cursor).toEqual({ kind: 'rowid', before: '0' });
    session.dispose();
  });

  it('cycles sort asc, desc, off and resets paging each time', async () => {
    const { session, states, calls } = makeSession(handlerFor());
    session.start();
    await waitFor(() => latest(states).rows.length > 0);

    session.handleMessage({ type: 'sort', column: 'name' });
    await waitFor(() => latest(states).sort?.direction === 'asc');
    const asc = calls.filter((call) => call.method === 'fetchPage').at(-1)?.params as FetchPageParams;
    expect(asc.sort).toEqual({ column: 'name', direction: 'asc' });
    expect(asc.cursor).toEqual({ kind: 'offset', offset: 0 });

    session.handleMessage({ type: 'sort', column: 'name' });
    await waitFor(() => latest(states).sort?.direction === 'desc');

    session.handleMessage({ type: 'sort', column: 'name' });
    await waitFor(() => latest(states).sort === null);
    const off = calls.filter((call) => call.method === 'fetchPage').at(-1)?.params as FetchPageParams;
    expect(off.sort).toBeUndefined();
    expect(off.cursor).toEqual({ kind: 'rowid' });
    session.dispose();
  });

  it('applies a filter, returns to the first page, and clears it', async () => {
    const { session, states, calls } = makeSession(handlerFor());
    session.start();
    await waitFor(() => latest(states).rows.length > 0);

    session.handleMessage({ type: 'filter', column: 'name', op: 'contains', value: 'ali' });
    await waitFor(() => latest(states).filter !== null);
    const filtered = calls.filter((call) => call.method === 'fetchPage').at(-1)?.params as FetchPageParams;
    expect(filtered.filter).toEqual({ column: 'name', op: 'contains', value: 'ali' });
    expect(filtered.cursor).toEqual({ kind: 'rowid' });

    session.handleMessage({ type: 'clearFilter' });
    await waitFor(() => latest(states).filter === null);
    session.dispose();
  });

  it('surfaces the lock owner and recovers when the lock is released', async () => {
    let locked = true;
    const base = handlerFor();
    const { session, states } = makeSession(async (call) => {
      if (call.method === 'listSchema' && locked) {
        throw new RpcError({ code: 'LOCKED', message: 'File is already open', pid: 4242, processName: 'python.exe' });
      }
      return base(call);
    });

    session.start();
    await waitFor(() => latest(states).status === 'locked');

    const lockedState = latest(states);
    expect(lockedState.lock).toEqual({ pid: 4242, processName: 'python.exe', waiting: false });
    expect(lockedState.error).toBeNull();

    locked = false;
    session.handleMessage({ type: 'waitForRelease' });
    await waitFor(() => latest(states).status === 'ready' && latest(states).rows.length > 0);
    expect(latest(states).lock).toBeNull();
    session.dispose();
  });

  it('warns when the file fingerprint changes between reads', async () => {
    let fingerprint = { mtimeMs: 1_000, size: 4_096 };
    const { session, states } = makeSession(async (call) => {
      if (call.method === 'listSchema') return { ...SCHEMA, fingerprint };
      return { ...fakePage(call.params as FetchPageParams), fingerprint };
    });

    session.start();
    await waitFor(() => latest(states).rows.length > 0);
    expect(latest(states).banner).toBeNull();

    fingerprint = { mtimeMs: 2_000, size: 8_192 };
    session.handleMessage({ type: 'nextPage' });
    await waitFor(() => latest(states).banner !== null);
    expect(latest(states).banner?.level).toBe('warn');

    session.handleMessage({ type: 'refresh' });
    await waitFor(() => latest(states).banner === null && latest(states).busy === false);
    session.dispose();
  });

  it('stops polling when waiting for release is cancelled', async () => {
    let locked = true;
    const { session, states, calls } = makeSession(async (call) => {
      if (call.method === 'listSchema' && locked) {
        throw new RpcError({ code: 'LOCKED', message: 'File is already open', pid: 1, processName: 'duckdb.exe' });
      }
      if (call.method === 'listSchema') return SCHEMA;
      return fakePage(call.params as FetchPageParams);
    });

    session.start();
    await waitFor(() => latest(states).status === 'locked');

    session.handleMessage({ type: 'waitForRelease' });
    await waitFor(() => calls.filter((call) => call.method === 'listSchema').length >= 4);

    session.handleMessage({ type: 'cancelWait' });
    const countAfterCancel = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.length).toBe(countAfterCancel);
    session.dispose();
  });

  it('interrupts the active request when the tab is disposed', async () => {
    const { session, calls } = makeSession(async (call) => {
      if (call.method === 'listSchema') return SCHEMA;
      if (call.method === 'fetchPage') return new Promise<FetchPageResult>(() => undefined);
      return {};
    });

    session.start();
    await waitFor(() => calls.some((call) => call.method === 'fetchPage'));

    session.dispose();
    await waitFor(() => calls.some((call) => call.method === 'interrupt'));
    expect(calls.find((call) => call.method === 'interrupt')?.params).toEqual({ targetId: 2 });
  });

  it('does not start a second request when disposed while the schema is loading', async () => {
    let resolveSchema: ((value: ListSchemaResult) => void) | undefined;
    const { session, calls } = makeSession(async (call) => {
      if (call.method === 'listSchema') {
        return new Promise<ListSchemaResult>((resolve) => {
          resolveSchema = resolve;
        });
      }
      if (call.method === 'fetchPage') return fakePage(call.params as FetchPageParams);
      return {};
    });

    session.start();
    await waitFor(() => calls.some((call) => call.method === 'listSchema'));

    session.dispose();
    resolveSchema?.(SCHEMA);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls.some((call) => call.method === 'fetchPage')).toBe(false);

    const afterDispose = calls.length;
    session.handleMessage({ type: 'refresh' });
    session.handleMessage({ type: 'nextPage' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.length).toBe(afterDispose);
  });

  it('interrupts the in-flight request when the user cancels', async () => {
    let resolvePage: ((value: FetchPageResult) => void) | undefined;
    const { session, states, calls } = makeSession(async (call) => {
      if (call.method === 'listSchema') return SCHEMA;
      if (call.method === 'fetchPage') {
        return new Promise<FetchPageResult>((resolve) => {
          resolvePage = resolve;
        });
      }
      return {};
    });

    session.start();
    await waitFor(() => calls.some((call) => call.method === 'fetchPage'));
    session.handleMessage({ type: 'cancelOperation' });
    await waitFor(() => calls.some((call) => call.method === 'interrupt'));

    expect(calls.find((call) => call.method === 'interrupt')?.params).toEqual({ targetId: 2 });

    resolvePage?.(
      fakePage({
        dbPath: 'C:/data/test.duckdb',
        schema: 'main',
        table: 'users',
        kind: 'table',
        columns: [],
        pageSize: 2,
        cursor: { kind: 'rowid' },
        maxCellChars: 64,
      }),
    );
    await waitFor(() => latest(states).busy === false);
    session.dispose();
  });

  it('applies a column layout without reading the database', async () => {
    const { session, states, calls, columnLayouts } = makeSession(handlerFor());
    session.start();
    await waitFor(() => latest(states).rows.length > 0);
    const pagesBefore = calls.filter((call) => call.method === 'fetchPage').length;

    session.handleMessage({
      type: 'setColumnLayout',
      schema: 'main',
      name: 'users',
      kind: 'table',
      layout: {
        version: 1,
        columns: { email: { width: 5_000, hidden: false }, name: { hidden: true } },
      },
    });

    await waitFor(() => latest(states).columnLayout?.columns.name?.hidden === true);
    expect(calls.filter((call) => call.method === 'fetchPage')).toHaveLength(pagesBefore);
    expect(latest(states).rows.length).toBeGreaterThan(0);

    const saved = columnLayouts.load('C:/data/test.duckdb', {
      schema: 'main',
      name: 'users',
      kind: 'table',
    });
    expect(saved.columns).toEqual({ email: { width: 2_000 }, name: { hidden: true } });
    session.dispose();
  });

  it('clears the sort and refetches the first page when the sorted column is hidden', async () => {
    const { session, states, calls } = makeSession(handlerFor());
    session.start();
    await waitFor(() => latest(states).rows.length > 0);

    session.handleMessage({ type: 'sort', column: 'name' });
    await waitFor(() => latest(states).sort?.direction === 'asc' && latest(states).busy === false);
    const pagesBefore = calls.filter((call) => call.method === 'fetchPage').length;

    session.handleMessage({
      type: 'setColumnLayout',
      schema: 'main',
      name: 'users',
      kind: 'table',
      layout: { version: 1, columns: { name: { hidden: true } } },
    });

    await waitFor(
      () =>
        latest(states).sort === null &&
        calls.filter((call) => call.method === 'fetchPage').length === pagesBefore + 1,
    );

    const lastPage = calls.filter((call) => call.method === 'fetchPage').at(-1)?.params as FetchPageParams;
    expect(lastPage.sort).toBeUndefined();
    expect(lastPage.cursor).toEqual({ kind: 'rowid' });
    expect(latest(states).pageIndex).toBe(0);
    session.dispose();
  });

  it('keeps layouts isolated per object and restores them when the object is selected again', async () => {
    const { session, states, columnLayouts } = makeSession(handlerFor());
    await columnLayouts.save(
      'C:/data/test.duckdb',
      { schema: 'main', name: 'orders', kind: 'table' },
      { version: 1, columns: { id: { pinned: true }, total: { hidden: true } } },
    );

    session.start();
    await waitFor(() => latest(states).selected?.name === 'users' && latest(states).rows.length > 0);
    expect(latest(states).columnLayout).toEqual({ version: 1, columns: {} });

    session.handleMessage({ type: 'selectObject', schema: 'main', name: 'orders', kind: 'table' });
    await waitFor(() => latest(states).selected?.name === 'orders' && latest(states).rows.length > 0);
    expect(latest(states).columnLayout).toEqual({
      version: 1,
      columns: { id: { pinned: true }, total: { hidden: true } },
    });

    session.handleMessage({
      type: 'setColumnLayout',
      schema: 'main',
      name: 'orders',
      kind: 'table',
      layout: { version: 1, columns: { id: { hidden: true } } },
    });
    await waitFor(() => latest(states).columnLayout?.columns.id?.hidden === true);

    session.handleMessage({ type: 'selectObject', schema: 'main', name: 'users', kind: 'table' });
    await waitFor(() => latest(states).selected?.name === 'users' && latest(states).rows.length > 0);
    expect(latest(states).columnLayout).toEqual({ version: 1, columns: {} });

    session.handleMessage({ type: 'selectObject', schema: 'main', name: 'orders', kind: 'table' });
    await waitFor(() => latest(states).selected?.name === 'orders' && latest(states).rows.length > 0);
    expect(latest(states).columnLayout).toEqual({
      version: 1,
      columns: { id: { hidden: true } },
    });
    session.dispose();
  });
});
